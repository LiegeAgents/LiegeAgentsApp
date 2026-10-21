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
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";

describe.skipIf(!databaseAvailable)("A2A", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function fixture() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const slug = (await db.query("SELECT slug FROM agents WHERE id = $1", [agentId])).rows[0].slug;
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
      [agentId, service.id, hook.id, ["usdg"]],
    );
    const key = (
      await api()
        .post("/v1/mcp/hire-keys")
        .set(bearer(client))
        .send({ name: "A2A client", maxBudgetPerHire: 6, dailyBudget: 10 })
        .expect(201)
    ).body.data.token as string;
    return { owner, client, slug, key };
  }

  const rpc = (key: string | null, method: string, params: object, path = "/v1/a2a") => {
    const call = api().post(path);
    if (key) call.set("authorization", `Bearer ${key}`);
    return call.send({ jsonrpc: "2.0", id: 1, method, params });
  };
  const send = (key: string, text: string, metadata?: object, path?: string) =>
    rpc(
      key,
      "message/send",
      {
        message: { role: "user", messageId: "m-1", parts: [{ kind: "text", text }] },
        ...(metadata ? { metadata } : {}),
      },
      path,
    );

  test("cards list hireable agents with the endpoint and the hiring-key scheme", async () => {
    const { slug } = await fixture();
    const card = (await api().get("/.well-known/agent-card.json").expect(200)).body;
    expect(card).toMatchObject({
      protocolVersion: "0.3.0",
      name: "Liege Super Agents",
      preferredTransport: "JSONRPC",
      url: "https://api.liegeagents.com/v1/a2a",
      capabilities: { streaming: false, pushNotifications: false },
      security: [{ hiringKey: [] }],
      securitySchemes: { hiringKey: { type: "http", scheme: "bearer" } },
    });
    expect(card.skills).toEqual([
      expect.objectContaining({ id: slug, name: "Research Agent: Research brief" }),
    ]);
    expect(card.skills[0].tags).toContain("verified");
    const own = (await api().get(`/v1/a2a/${slug}/agent-card.json`).expect(200)).body;
    expect(own).toMatchObject({
      name: "Research Agent",
      url: `https://api.liegeagents.com/v1/a2a/${slug}`,
    });
    await api().get("/v1/a2a/nobody/agent-card.json").expect(404);
  });

  test("a message becomes a proposal task that completes with the delivered work", async () => {
    const { owner, client, slug, key } = await fixture();
    // The agent's own endpoint needs no name in the text; the listed price is the budget.
    const sent = (
      await send(key, "A market scan of tokenized stocks", undefined, `/v1/a2a/${slug}`).expect(200)
    ).body;
    expect(sent).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { kind: "task", status: { state: "submitted" } },
    });
    expect(sent.result.status.message.parts[0].text).toContain(
      "Nothing is paid until they approve and fund it",
    );
    const taskId = sent.result.id as string;
    const intent = (
      await db.query("SELECT parsed, source FROM superagent_intents WHERE id = $1", [taskId])
    ).rows[0];
    expect(intent).toMatchObject({ source: "mcp", parsed: { budgetAmount: 5 } });

    const job = (
      await api()
        .post(`/v1/super-agents/intents/${taskId}/decision`)
        .set(bearer(client))
        .send({ decision: "approved" })
        .expect(200)
    ).body.data.job;
    expect((await rpc(key, "tasks/get", { id: taskId })).body.result.status.state).toBe(
      "submitted",
    );
    await credit(client.userId, 10);
    await api().post(`/v1/jobs/${job.id}/fund`).set(bearer(client)).send({}).expect(200);
    expect((await rpc(key, "tasks/get", { id: taskId })).body.result.status.state).toBe("working");
    await api()
      .post(`/v1/jobs/${job.id}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "# Market scan" })
      .expect(200);
    const done = (await rpc(key, "tasks/get", { id: taskId })).body.result;
    expect(done.status.state).toBe("completed");
    expect(done.artifacts[0].parts[0]).toEqual({ kind: "text", text: "# Market scan" });
  });

  test("the marketplace endpoint reads the agent from the text and keeps the key's limits", async () => {
    const { key } = await fixture();
    const sent = (
      await send(key, "Hire Research Agent for a market scan", { budgetAmount: 4 }).expect(200)
    ).body;
    expect(sent.result.status.state).toBe("submitted");
    const over = (
      await send(key, "Hire Research Agent for a market scan", { budgetAmount: 7 }).expect(200)
    ).body;
    expect(over.error).toMatchObject({ code: -32602, data: { code: "hire_cap_exceeded" } });
    const nobody = (await send(key, "Hire Nobody for a scan", { budgetAmount: 4 })).body;
    expect(nobody.error.data.code).toBe("agent_unavailable");
  });

  test("errors follow JSON-RPC, and calls need a hiring key", async () => {
    const { key } = await fixture();
    await rpc(null, "tasks/get", { id: crypto.randomUUID() }).expect(401);
    await rpc("lmh_" + "0".repeat(64), "tasks/get", { id: crypto.randomUUID() }).expect(401);
    expect((await rpc(key, "tasks/get", { id: crypto.randomUUID() })).body.error.code).toBe(-32001);
    expect((await rpc(key, "tasks/cancel", { id: crypto.randomUUID() })).body.error.code).toBe(
      -32601,
    );
    expect((await rpc(key, "tasks/get", {})).body.error.code).toBe(-32602);
    expect((await api().post("/v1/a2a").send({ hello: true })).body.error.code).toBe(-32600);
    const reply = await rpc(key, "message/send", {
      message: {
        role: "user",
        messageId: "m-2",
        taskId: "t-1",
        parts: [{ kind: "text", text: "more" }],
      },
    });
    expect(reply.body.error.code).toBe(-32004);
  });
});
