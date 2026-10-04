import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { hashRuntimeToken } from "../src/auth.js";
import { findEnrolledAgent } from "../src/superAgentEnrollment.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  openJob,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("agent deactivation", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function enrolledAgent() {
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
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1, $2, $3, true, now())`,
      [agentId, service.id, hook.id],
    );
    return { owner, agentId, serviceId: service.id as string };
  }

  test("the owner removes the agent from the marketplace, its services, and Super Agents", async () => {
    const { owner, agentId, serviceId } = await enrolledAgent();
    const { slug } = (await db.query("SELECT slug FROM agents WHERE id = $1", [agentId])).rows[0];
    expect((await findEnrolledAgent("Research Agent"))?.id).toBe(agentId);

    const response = await api()
      .post(`/v1/agents/${agentId}/deactivate`)
      .set(bearer(owner))
      .expect(200);
    expect(response.body.data).toMatchObject({ id: agentId, active: false });

    await api().get(`/v1/agents/${slug}`).expect(404);
    const listed = await api().get("/v1/agents").expect(200);
    expect(listed.body.data.map((agent: { id: string }) => agent.id)).not.toContain(agentId);
    expect(
      (await db.query("SELECT active FROM commerce_services WHERE id = $1", [serviceId])).rows[0],
    ).toEqual({ active: false });
    expect(
      (await db.query("SELECT enabled FROM superagent_enrollments WHERE agent_id = $1", [agentId]))
        .rows[0],
    ).toEqual({ enabled: false });
    expect(await findEnrolledAgent("Research Agent")).toBeNull();

    const audit = await db.query(
      "SELECT actor_id, metadata FROM audit_logs WHERE action = 'agent.deactivated' AND target_id = $1",
      [agentId],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: owner.userId,
        metadata: { slug, servicesDeactivated: 1, superAgentEnrollmentsDisabled: 1 },
      },
    ]);

    const client = await signIn();
    await credit(client.userId, 100);
    await openJob(client, agentId, 10).expect(404);
    await api().post(`/v1/agents/${agentId}/deactivate`).set(bearer(owner)).expect(404);
  });

  test("only the owner can deactivate, and never with a runtime token", async () => {
    const { owner, agentId } = await enrolledAgent();
    const stranger = await signIn();
    const missing = await api()
      .post(`/v1/agents/${agentId}/deactivate`)
      .set(bearer(stranger))
      .expect(404);
    expect(missing.body.error.code).toBe("agent_not_found");

    const runtimeToken = `runtime-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO runtime_tokens (owner_id, token_hash, agent_ids) VALUES ($1,$2,$3)",
      [owner.userId, hashRuntimeToken(runtimeToken), [agentId]],
    );
    const refused = await api()
      .post(`/v1/agents/${agentId}/deactivate`)
      .set({ Authorization: `Bearer ${runtimeToken}`, "x-liege-runtime-token": "1" })
      .expect(403);
    expect(refused.body.error.code).toBe("runtime_token_not_allowed");

    await api().post("/v1/agents/not-a-uuid/deactivate").set(bearer(owner)).expect(400);
    await api().post(`/v1/agents/${agentId}/deactivate`).expect(401);
    expect((await db.query("SELECT active FROM agents WHERE id = $1", [agentId])).rows[0]).toEqual({
      active: true,
    });
  });

  test("an agent with work in progress cannot be deactivated", async () => {
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const client = await signIn();
    await credit(client.userId, 100);
    await openJob(client, agentId, 10).expect(201);

    const conflict = await api()
      .post(`/v1/agents/${agentId}/deactivate`)
      .set(bearer(owner))
      .expect(409);
    expect(conflict.body.error.code).toBe("agent_has_active_jobs");
    expect((await db.query("SELECT active FROM agents WHERE id = $1", [agentId])).rows[0]).toEqual({
      active: true,
    });
  });
});
