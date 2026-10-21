import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
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

describe.skipIf(!databaseAvailable)("hiring keys", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  // "Research Agent" lists 5 USD and accepts as low as 4 when countered.
  async function fixture() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "research-brief",
          name: "Research brief",
          description: "A cited research brief.",
          serviceType: "skill",
          priceUsd: 5,
          minPriceUsd: 4,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, settlement_assets)
       VALUES ($1,$2,$3,true,now(),$4)`,
      [agentId, service.id, hook.id, ["usdg", "liege"]],
    );
    return { owner, client, agentId };
  }

  const createKey = async (user: User, body: object = {}) =>
    (
      await api()
        .post("/v1/mcp/hire-keys")
        .set(bearer(user))
        .send({ name: "Research bot", maxBudgetPerHire: 6, dailyBudget: 10, ...body })
        .expect(201)
    ).body.data as { id: string; token: string; presets: Record<string, any> };

  const hire = (token: string) => {
    const headers = {
      "x-mcp-internal-token": process.env.MCP_INTERNAL_API_TOKEN!,
      "x-mcp-connection-token": token,
    };
    return {
      get: (path: string) => api().get(`/v1/internal/mcp/hire${path}`).set(headers),
      post: (path: string, body: object) =>
        api().post(`/v1/internal/mcp/hire${path}`).set(headers).send(body),
    };
  };
  const text = "Hire Research Agent for a market scan";

  test("a key lists agents, quotes, and proposes; the proposal waits for the owner's approval", async () => {
    const { client } = await fixture();
    const key = await createKey(client);
    expect(key.token).toStartWith("lmh_");
    expect(key.presets.claude_desktop.config.mcpServers["liege-hire"].headers.Authorization).toBe(
      `Bearer ${key.token}`,
    );
    const agents = (await hire(key.token).get("/agents").expect(200)).body.data;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "Research Agent", verified: true });
    expect(agents[0]).not.toHaveProperty("min_price_usd");

    const quote = (await hire(key.token).post("/quote", { text }).expect(200)).body.data;
    expect(quote.quote).toMatchObject({ suggestedBudget: 5 });

    const proposal = (
      await hire(key.token).post("/proposals", { text, budgetAmount: 5 }).expect(201)
    ).body.data;
    expect(proposal).toMatchObject({ status: "pending" });
    expect(proposal.note).toContain("Nothing is paid until they approve and fund it");

    // It appears in the client's Requests labelled with the key; no job exists yet.
    const listed = (await api().get("/v1/super-agents/intents").set(bearer(client)).expect(200))
      .body.data;
    expect(listed[0]).toMatchObject({
      id: proposal.id,
      source: "mcp",
      hire_key_name: "Research bot",
    });
    expect((await db.query("SELECT 1 FROM jobs")).rowCount).toBe(0);
    const pending = (await hire(key.token).get(`/proposals/${proposal.id}/result`).expect(200)).body
      .data;
    expect(pending).toMatchObject({ proposalStatus: "pending", jobId: null, deliverable: null });
  });

  test("the key counters within its caps, and reads the delivered result after approval", async () => {
    const { owner, client } = await fixture();
    const key = await createKey(client);
    const { id } = (await hire(key.token).post("/proposals", { text, budgetAmount: 5 }).expect(201))
      .body.data;
    const countered = (await hire(key.token).post(`/proposals/${id}/counter`, { budgetAmount: 3 }))
      .body.data;
    expect(countered.round).toMatchObject({ outcome: "countered", agreed: 4 });

    const job = (
      await api()
        .post(`/v1/super-agents/intents/${id}/decision`)
        .set(bearer(client))
        .send({ decision: "approved" })
        .expect(200)
    ).body.data.job;
    await credit(client.userId, 10);
    await api().post(`/v1/jobs/${job.id}/fund`).set(bearer(client)).send({}).expect(200);
    const waiting = (await hire(key.token).get(`/proposals/${id}/result`).expect(200)).body.data;
    expect(waiting).toMatchObject({ jobId: job.id, deliverable: null });
    await api()
      .post(`/v1/jobs/${job.id}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "# Market scan" })
      .expect(200);

    const result = (await hire(key.token).get(`/proposals/${id}/result`).expect(200)).body.data;
    expect(result).toMatchObject({ proposalStatus: "approved", deliverable: "# Market scan" });
    const mine = (await hire(key.token).get("/proposals").expect(200)).body.data;
    expect(mine[0]).toMatchObject({ id, job_id: job.id });
  });

  test("caps limit each proposal and the daily total, and only USDG can be proposed", async () => {
    const { client } = await fixture();
    const key = await createKey(client);
    expect(
      (await hire(key.token).post("/proposals", { text, budgetAmount: 7 }).expect(422)).body.error
        .code,
    ).toBe("hire_cap_exceeded");
    await hire(key.token).post("/proposals", { text, budgetAmount: 6 }).expect(201);
    const over = await hire(key.token).post("/proposals", { text, budgetAmount: 5 }).expect(422);
    expect(over.body.error).toMatchObject({
      code: "hire_daily_cap_exceeded",
      message: "This key has 4 of its 10 USDG daily budget left.",
    });
    await hire(key.token).post("/proposals", { text, budgetAmount: 4 }).expect(201);
    expect(
      (
        await hire(key.token)
          .post("/proposals", { text: `${text}, budget 100 LIEGE` })
          .expect(422)
      ).body.error.code,
    ).toBe("hire_key_usdg_only");
    // Proposals nobody approved stop counting once they are rejected.
    const pending = (await api().get("/v1/super-agents/intents").set(bearer(client))).body.data;
    await api()
      .post(`/v1/super-agents/intents/${pending[0].id}/decision`)
      .set(bearer(client))
      .send({ decision: "rejected" })
      .expect(200);
    await hire(key.token).post("/proposals", { text, budgetAmount: 4 }).expect(201);
  });

  test("keys are owner-scoped, revocable, and never act on other proposals", async () => {
    const { client } = await fixture();
    const other = await signIn();
    const key = await createKey(client);
    await api()
      .post("/v1/mcp/hire-keys")
      .set(bearer(client))
      .send({ name: "Bad", maxBudgetPerHire: 6, dailyBudget: 5 })
      .expect(400);
    // A proposal made in the dashboard is not the key's to counter or read.
    const own = (
      await api()
        .post("/v1/super-agents/intents")
        .set(bearer(client))
        .send({ text, budgetAmount: 5 })
        .expect(201)
    ).body.data.id;
    expect(
      (await hire(key.token).post(`/proposals/${own}/counter`, { budgetAmount: 4 }).expect(409))
        .body.error.code,
    ).toBe("proposal_unavailable");
    await hire(key.token).get(`/proposals/${own}/result`).expect(404);

    const listed = (await api().get("/v1/mcp/hire-keys").set(bearer(client)).expect(200)).body.data;
    expect(listed[0]).toMatchObject({ id: key.id, name: "Research bot" });
    expect(listed[0]).not.toHaveProperty("token_hash");
    await api().delete(`/v1/mcp/hire-keys/${key.id}`).set(bearer(other)).expect(404);
    await api().delete(`/v1/mcp/hire-keys/${key.id}`).set(bearer(client)).expect(204);
    expect((await hire(key.token).get("/agents").expect(401)).body.error.code).toBe(
      "invalid_hire_key",
    );
    // Provider connection tokens and missing service tokens are refused.
    await hire("lmp_" + "0".repeat(64))
      .get("/agents")
      .expect(401);
    await api()
      .get("/v1/internal/mcp/hire/agents")
      .set("x-mcp-connection-token", key.token)
      .expect(401);
  });
});
