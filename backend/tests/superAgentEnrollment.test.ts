import { beforeAll, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
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
import { createWebhookSubscription } from "../src/webhooks.js";
import { findEnrolledAgent } from "../src/superAgentEnrollment.js";
import { probeTransport } from "../src/superAgentProbe.js";

describe.skipIf(!databaseAvailable)("Super Agent enrollment", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);
  async function fixture() {
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "research-brief",
          name: "Research brief",
          description: "A cited research brief with sources and findings.",
          serviceType: "skill",
          priceUsd: 5,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/webhook", [
      "job.funded",
    ]);
    return { owner, agentId, service, hook };
  }
  test("enforces ownership, verification, readiness and discovery on both matching surfaces", async () => {
    const { owner, agentId, service, hook } = await fixture();
    const stranger = await signIn();
    const input = { agentId, serviceId: service.id, webhookId: hook.id };
    await api().post("/v1/super-agents/enrollments").set(bearer(stranger)).send(input).expect(422);
    await api().post("/v1/super-agents/enrollments").set(bearer(owner)).send(input).expect(201);
    expect(await findEnrolledAgent("Research Agent")).toBeNull();
    await api()
      .post(`/v1/super-agents/enrollments/${agentId}/discovery`)
      .set(bearer(owner))
      .send({ enabled: true })
      .expect(409);
    const fetchMock = spyOn(probeTransport, "send").mockImplementation(async (_url, body) => {
      const probe = JSON.parse(body);
      expect(probe.type).toBe("superagent.connection_test");
      expect(probe.agentId).toBe(agentId);
      const proof = createHmac("sha256", hook.secret)
        .update(`superagent.connection_test:${agentId}:${probe.challenge}`)
        .digest("hex");
      return { ok: true, proof };
    });
    try {
      await api()
        .post(`/v1/super-agents/enrollments/${agentId}/verify`)
        .set(bearer(owner))
        .send({})
        .expect(200);
    } finally {
      fetchMock.mockRestore();
    }
    await api()
      .post(`/v1/super-agents/enrollments/${agentId}/discovery`)
      .set(bearer(owner))
      .send({ enabled: true })
      .expect(200);
    expect((await findEnrolledAgent("Research Agent"))?.id).toBe(agentId);
    await api()
      .post(`/v1/super-agents/enrollments/${agentId}/discovery`)
      .set(bearer(stranger))
      .send({ enabled: false })
      .expect(409);
    await db.query("UPDATE webhook_subscriptions SET active=false WHERE id=$1", [hook.id]);
    expect(await findEnrolledAgent("Research Agent")).toBeNull();
    await api()
      .post(`/v1/super-agents/enrollments/${agentId}/discovery`)
      .set(bearer(owner))
      .send({ enabled: false })
      .expect(200);
  });
  test("lists the agent's settlement assets separately from its enrollment's", async () => {
    const { owner, agentId, service, hook } = await fixture();
    const listed = async () =>
      (await api().get("/v1/super-agents/enrollments").set(bearer(owner)).expect(200)).body.data
        .agents[0];
    expect(await listed()).toMatchObject({
      id: agentId,
      settlement_assets: ["usdg", "liege"],
      enrollment_settlement_assets: null,
    });
    await api()
      .post("/v1/super-agents/enrollments")
      .set(bearer(owner))
      .send({ agentId, serviceId: service.id, webhookId: hook.id, settlementAssets: ["usdg"] })
      .expect(201);
    expect(await listed()).toMatchObject({
      settlement_assets: ["usdg", "liege"],
      enrollment_settlement_assets: ["usdg"],
    });
  });

  test("rejects a reachable runtime that cannot prove it holds the webhook secret", async () => {
    const { owner, agentId, service, hook } = await fixture();
    await api()
      .post("/v1/super-agents/enrollments")
      .set(bearer(owner))
      .send({ agentId, serviceId: service.id, webhookId: hook.id })
      .expect(201);
    const fetchMock = spyOn(probeTransport, "send").mockImplementation(async () => ({
      ok: true,
      proof: "",
    }));
    try {
      await api()
        .post(`/v1/super-agents/enrollments/${agentId}/verify`)
        .set(bearer(owner))
        .send({})
        .expect(422);
    } finally {
      fetchMock.mockRestore();
    }
    await api()
      .post(`/v1/super-agents/enrollments/${agentId}/discovery`)
      .set(bearer(owner))
      .send({ enabled: true })
      .expect(409);
  });
});
