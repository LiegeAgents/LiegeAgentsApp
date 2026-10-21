import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { env } from "../src/config.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { callProof } from "../src/superAgentCalls.js";
import { callTransport } from "../src/superAgentProbe.js";
import { x402Transport } from "../src/x402.js";

const payer = "0x" + "77".repeat(20);
const usdg = "0x" + "5d".repeat(20);

const signed = (nonce: string, from = payer) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      payload: { signature: "0xsig", authorization: { from, nonce, value: "250000" } },
    }),
  ).toString("base64");

describe.skipIf(!databaseAvailable)("instant calls over x402", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);
  const original = { url: env.X402_FACILITATOR_URL, token: env.USDG_TOKEN_ADDRESS };
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    env.X402_FACILITATOR_URL = original.url;
    env.USDG_TOKEN_ADDRESS = original.token;
  });

  /** A facilitator that accepts every payment from `payer`, recording what it was asked. */
  function facilitator(options: { settle?: boolean } = {}) {
    env.X402_FACILITATOR_URL = "https://facilitator.example";
    env.USDG_TOKEN_ADDRESS = usdg;
    const seen: Array<{ path: string; body: any }> = [];
    spies.push(
      spyOn(x402Transport, "post").mockImplementation(async (url, init) => {
        const body = JSON.parse(String(init.body));
        seen.push({ path: url.pathname, body });
        const network = body.paymentRequirements.network;
        return Response.json(
          url.pathname === "/verify"
            ? { isValid: true, payer }
            : options.settle === false
              ? { success: false, errorReason: "insufficient_funds" }
              : { success: true, payer, transaction: "0x" + "ab".repeat(32), network },
        );
      }),
    );
    return seen;
  }

  function runtime(secret: string, reply: "answer" | "decline" = "answer") {
    const sent: any[] = [];
    spies.push(
      spyOn(callTransport, "send").mockImplementation(async (_url, body) => {
        const event = JSON.parse(body);
        sent.push(event);
        if (reply === "decline")
          return {
            status: 200,
            proof: "",
            body: JSON.stringify({ data: { status: "declined", reason: "No token address." } }),
          };
        const output = "# Rug check\nNo major red flags.";
        return {
          status: 200,
          proof: callProof(secret, event.callId, output),
          body: JSON.stringify({ data: { status: "answered", output } }),
        };
      }),
    );
    return sent;
  }

  async function fixture() {
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "rug-check",
          name: "Rug check",
          description: "A rug-pull risk report for one token.",
          serviceType: "skill",
          priceUsd: 2,
          slaMinutes: 30,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, call_price_usdg)
       VALUES ($1,$2,$3,true,now(),0.25)`,
      [agentId, service.id, hook.id],
    );
    return { owner, agentId, secret: hook.secret };
  }

  const pay = (agentId: string, signature?: string) => {
    const request = api().post(`/v1/x402/calls/${agentId}`).send({ input: "Check 0xabc" });
    return signature ? request.set("PAYMENT-SIGNATURE", signature) : request;
  };

  test("is off until a facilitator is configured", async () => {
    const { agentId } = await fixture();
    env.X402_FACILITATOR_URL = undefined;
    expect((await pay(agentId).expect(501)).body.error.code).toBe("x402_not_configured");
  });

  test("quotes the price to the owner's wallet, then answers and settles once paid", async () => {
    const { owner, agentId, secret } = await fixture();
    const seen = facilitator();
    const sent = runtime(secret);

    const quote = await pay(agentId).expect(402);
    expect(quote.headers["payment-required"]).toBeTruthy();
    expect(quote.body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: `eip155:${env.RHC_ID}`,
      amount: "250000",
      asset: usdg,
      payTo: owner.address.toLowerCase(),
    });

    const paid = await pay(agentId, signed("0x01")).expect(200);
    expect(paid.headers["payment-response"]).toBeTruthy();
    expect(paid.body.data).toMatchObject({
      status: "succeeded",
      charged: true,
      price: "0.25",
      payerWallet: payer,
      output: "# Rug check\nNo major red flags.",
    });
    // Verified before the agent was called, settled only after it answered.
    expect(seen.map((item) => item.path)).toEqual(["/verify", "/settle"]);
    expect(sent).toHaveLength(1);

    // The owner sees the call and its settlement, but not the content.
    const calls = (await api().get("/v1/super-agents/calls").set(bearer(owner)).expect(200)).body
      .data;
    expect(calls[0]).toMatchObject({
      paymentMethod: "x402",
      payerWallet: payer,
      settlementTransaction: "0x" + "ab".repeat(32),
      role: "agent_owner",
    });

    // The same signed payment cannot buy a second call.
    expect((await pay(agentId, signed("0x01")).expect(409)).body.error.code).toBe(
      "payment_already_used",
    );
    expect(sent).toHaveLength(1);
  });

  test("a declined call is never settled, and an unsettled answer is withheld", async () => {
    const { agentId, secret } = await fixture();
    let seen = facilitator();
    runtime(secret, "decline");
    const declined = await pay(agentId, signed("0x02")).expect(502);
    expect(declined.body.error.message).toContain("you were not charged");
    expect(seen.map((item) => item.path)).toEqual(["/verify"]);
    spies.splice(0).forEach((spy) => spy.mockRestore());

    seen = facilitator({ settle: false });
    runtime(secret);
    const unpaid = await pay(agentId, signed("0x03")).expect(402);
    expect(unpaid.body.error).toBe("insufficient_funds");
    expect(JSON.stringify(unpaid.body)).not.toContain("No major red flags");
    const rows = await db.query(
      "SELECT status, error, output_ciphertext FROM superagent_calls ORDER BY created_at",
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["refunded", "refunded"]);
    expect(rows.rows[1].output_ciphertext).toBeNull();
    expect(rows.rows[1].error).toContain("the answer was withheld");
  });

  test("refuses agents without a USDG call price, and owners paying themselves", async () => {
    const { owner, agentId } = await fixture();
    facilitator();
    await db.query("UPDATE superagent_enrollments SET call_price_usdg = NULL");
    expect((await pay(agentId).expect(422)).body.error.code).toBe("instant_calls_not_offered");
    await db.query("UPDATE superagent_enrollments SET call_price_usdg = 0.25");
    spies.splice(0).forEach((spy) => spy.mockRestore());
    env.X402_FACILITATOR_URL = "https://facilitator.example";
    spies.push(
      spyOn(x402Transport, "post").mockImplementation(async () =>
        Response.json({ isValid: true, payer: owner.address }),
      ),
    );
    expect((await pay(agentId, signed("0x04", owner.address)).expect(422)).body.error.code).toBe(
      "self_hire_not_allowed",
    );
  });
});
