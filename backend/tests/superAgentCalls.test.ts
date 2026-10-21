import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { callProof, refundStaleCalls } from "../src/superAgentCalls.js";
import { callTransport } from "../src/superAgentProbe.js";

describe.skipIf(!databaseAvailable)("pay-per-call Super Agents", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);
  let transport: ReturnType<typeof spyOn<typeof callTransport, "send">> | undefined;
  afterEach(() => transport?.mockRestore());

  // A verified Super Agent selling rug checks, and a client with 10 USDG.
  async function fixture() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
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
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,now())`,
      [agentId, service.id, hook.id],
    );
    await credit(client.userId, 10);
    return { owner, client, agentId, secret: hook.secret };
  }

  const setPrices = (owner: User, agentId: string, body: object) =>
    api().put(`/v1/super-agents/enrollments/${agentId}/call-prices`).set(bearer(owner)).send(body);

  const call = (client: User, body: object) =>
    api().post("/v1/super-agents/calls").set(bearer(client)).send(body);

  /** The runtime answers every call with this text, signed with the webhook secret. */
  function answer(secret: string, output: string, overrides: { proof?: string } = {}) {
    const seen: Array<Record<string, unknown>> = [];
    transport = spyOn(callTransport, "send").mockImplementation(async (_url, body) => {
      const event = JSON.parse(body);
      seen.push(event);
      return {
        status: 200,
        proof: overrides.proof ?? callProof(secret, event.callId, output),
        body: JSON.stringify({ data: { status: "answered", output } }),
      };
    });
    return seen;
  }

  test("owners price instant calls within the cap and only in enrolled assets", async () => {
    const { owner, client, agentId } = await fixture();
    expect((await setPrices(client, agentId, { usdg: 0.25 }).expect(404)).body.error.code).toBe(
      "enrollment_not_found",
    );
    expect((await setPrices(owner, agentId, { usdg: 6 }).expect(422)).body.error.code).toBe(
      "call_price_too_high",
    );
    expect((await setPrices(owner, agentId, { liege: 100 }).expect(422)).body.error.code).toBe(
      "settlement_asset_not_supported",
    );
    const set = await setPrices(owner, agentId, { usdg: 0.25 }).expect(200);
    expect(Number(set.body.data.call_price_usdg)).toBe(0.25);
    // Prices show on the dashboard so clients can see what a call costs.
    const listed = (await api().get("/v1/super-agents/dashboard").set(bearer(client)).expect(200))
      .body.data.agents;
    expect(
      Number(listed.find((agent: { id: string }) => agent.id === agentId).call_price_usdg),
    ).toBe(0.25);
  });

  test("a call is answered while the client waits and pays the owner, once", async () => {
    const { owner, client, agentId, secret } = await fixture();
    await setPrices(owner, agentId, { usdg: 0.25 }).expect(200);
    const seen = answer(secret, "# Rug check\nNo major red flags.");

    const made = await call(client, {
      agentId,
      input: "Check 0x" + "ab".repeat(20),
      idempotencyKey: "first-call-1",
    }).expect(201);
    expect(made.body.data).toMatchObject({
      status: "succeeded",
      charged: true,
      price: "0.25",
      settlementAsset: "usdg",
      serviceSlug: "rug-check",
      output: "# Rug check\nNo major red flags.",
    });
    expect(seen[0]).toMatchObject({ type: "superagent.call", agentId, serviceSlug: "rug-check" });
    expect(await availableBalance(client.userId)).toBe(9.75);
    expect(await availableBalance(owner.userId)).toBe(0.25);

    // Retrying with the same key returns the same call and does not charge again.
    const again = await call(client, {
      agentId,
      input: "Check 0x" + "ab".repeat(20),
      idempotencyKey: "first-call-1",
    }).expect(200);
    expect(again.body.data.id).toBe(made.body.data.id);
    expect(seen).toHaveLength(1);
    expect(await availableBalance(client.userId)).toBe(9.75);

    // The client sees their input and answer; the owner sees the call without either.
    const id = made.body.data.id;
    expect(
      (await api().get(`/v1/super-agents/calls/${id}`).set(bearer(client)).expect(200)).body.data
        .input,
    ).toContain("Check 0x");
    const ownerView = (
      await api().get(`/v1/super-agents/calls/${id}`).set(bearer(owner)).expect(200)
    ).body.data;
    expect(ownerView).toMatchObject({ role: "agent_owner", input: null, output: null });
    const stranger = await signIn();
    await api().get(`/v1/super-agents/calls/${id}`).set(bearer(stranger)).expect(404);
    const list = (await api().get("/v1/super-agents/calls").set(bearer(owner)).expect(200)).body
      .data;
    expect(list).toHaveLength(1);
    expect(list[0].output).toBeUndefined();
  });

  test("declines, bad proofs, and unreachable agents refund in full", async () => {
    const { owner, client, agentId, secret } = await fixture();
    await setPrices(owner, agentId, { usdg: 1 }).expect(200);

    answer(secret, "A forged answer.", { proof: "0".repeat(64) });
    const forged = await call(client, { agentId, input: "Check this token." }).expect(502);
    expect(forged.body.error.code).toBe("call_failed");
    expect(forged.body.data).toMatchObject({ status: "refunded", charged: false });
    transport!.mockRestore();

    transport = spyOn(callTransport, "send").mockImplementation(async () => ({
      status: 200,
      proof: "",
      body: JSON.stringify({ data: { status: "declined", reason: "No address in the request." } }),
    }));
    const declined = await call(client, { agentId, input: "Is it safe?" }).expect(502);
    expect(declined.body.error.message).toContain("The agent declined: No address in the request.");
    transport.mockRestore();

    transport = spyOn(callTransport, "send").mockRejectedValue(
      new Error("The agent did not answer in time."),
    );
    await call(client, { agentId, input: "Check this token." }).expect(502);

    expect(await availableBalance(client.userId)).toBe(10);
    expect(await availableBalance(owner.userId)).toBe(0);
    const held = await db.query(
      `SELECT COALESCE(sum(p.amount), 0)::text AS amount FROM ledger_postings p
       JOIN ledger_accounts a ON a.id = p.account_id WHERE a.kind = 'held'`,
    );
    expect(Number(held.rows[0].amount)).toBe(0);
  });

  test("calls are refused without a price, funds, or a different owner", async () => {
    const { owner, client, agentId, secret } = await fixture();
    expect((await call(client, { agentId, input: "Hello" }).expect(422)).body.error.code).toBe(
      "instant_calls_not_offered",
    );
    await setPrices(owner, agentId, { usdg: 5 }).expect(200);
    await credit(owner.userId, 10);
    expect((await call(owner, { agentId, input: "Hello" }).expect(422)).body.error.code).toBe(
      "self_hire_not_allowed",
    );
    const poor = await signIn();
    await credit(poor.userId, 1);
    const seen = answer(secret, "Hi");
    expect((await call(poor, { agentId, input: "Hello" }).expect(402)).body.error.code).toBe(
      "insufficient_credits",
    );
    expect(seen).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM superagent_calls")).toMatchObject({ rowCount: 0 });
    expect(
      (await call(client, { agentId: crypto.randomUUID(), input: "Hello" }).expect(404)).body.error
        .code,
    ).toBe("call_agent_unavailable");
  });

  test("a call left pending by a restart is refunded by the sweeper", async () => {
    const { owner, client, agentId } = await fixture();
    await setPrices(owner, agentId, { usdg: 2 }).expect(200);
    // Simulate a crash after the hold: hold the price, then age the call past the timeout.
    transport = spyOn(callTransport, "send").mockImplementation(async () => {
      await db.query(
        "UPDATE superagent_calls SET created_at = now() - interval '10 minutes' WHERE status = 'pending'",
      );
      expect(await refundStaleCalls()).toBe(1);
      return { status: 200, proof: "", body: "{}" };
    });
    const made = await call(client, { agentId, input: "Check this token." }).expect(502);
    expect(made.body.data.error).toBe("The call did not finish, so it was refunded.");
    expect(await availableBalance(client.userId)).toBe(10);
  });
});
