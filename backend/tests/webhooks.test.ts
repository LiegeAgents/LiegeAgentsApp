import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  enqueueWebhookEvent,
  formatWebhookSseEvent,
  parseWebhookCursor,
  replayWebhookEvents,
  requestedWebhookCursor,
} from "../src/webhooks.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("webhook event cursors", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("replays an owned agent's events in cursor order with a stable event identity", async () => {
    const [client, provider] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(provider);
    const jobId = await createJob(client, agentId, 10);
    await enqueueWebhookEvent(db, { jobId, eventType: "job.funded" });
    await enqueueWebhookEvent(db, { jobId, eventType: "job.submitted" });

    const events = await replayWebhookEvents(db, agentId, 0n);
    expect(events).toHaveLength(2);
    expect(BigInt(events[0].cursor) < BigInt(events[1].cursor)).toBe(true);
    expect(events.map((event) => event.payload.id)).toEqual(events.map((event) => event.id));
    expect(events.map((event) => event.payload.jobId)).toEqual([jobId, jobId]);
    expect(formatWebhookSseEvent(events[0])).toContain(`id: ${events[0].cursor}`);
    expect(
      (await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200)).body.data.jobId,
    ).toBe(jobId);

    const resumed = await replayWebhookEvents(db, agentId, BigInt(events[0].cursor));
    expect(resumed.map((event) => event.id)).toEqual([events[1].id]);
  });

  test("delivery history is owner-scoped and never returns the webhook secret or event payload", async () => {
    const [owner, other] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const jobId = await createJob(other, agentId, 10);
    const subscriptionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO webhook_subscriptions
         (id, owner_id, agent_id, url, secret_hash, secret_ciphertext, event_types)
       VALUES ($1,$2,$3,'https://hooks.example.test/liege','hash','ciphertext','{job.funded}')`,
      [subscriptionId, owner.userId, agentId],
    );
    await enqueueWebhookEvent(db, {
      jobId,
      eventType: "job.funded",
      data: { privateNote: "must not be returned" },
    });
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', attempt = 12, response_status = 503,
         last_error = $2, next_attempt_at = now() + interval '1 hour'
       WHERE subscription_id = $1`,
      [subscriptionId, `temporary\nerror ${"x".repeat(300)}`],
    );

    const history = await api()
      .get(`/v1/webhooks/${subscriptionId}/deliveries?limit=5`)
      .set(bearer(owner))
      .expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      event_type: "job.funded",
      job_id: jobId,
      status: "failed",
      attempt: 12,
      response_status: 503,
    });
    expect(history.body.data[0].last_error).not.toContain("\n");
    expect(history.body.data[0].last_error.length).toBeLessThanOrEqual(240);
    expect(history.body.data[0]).not.toHaveProperty("payload");
    expect(history.body.data[0]).not.toHaveProperty("secret");
    await api().get(`/v1/webhooks/${subscriptionId}/deliveries`).set(bearer(other)).expect(404);
  });
});

test("webhook cursor parser accepts after and Last-Event-ID recovery", () => {
  expect(requestedWebhookCursor("42", "41")).toBe(42n);
  expect(requestedWebhookCursor(undefined, "41")).toBe(41n);
  expect(() => parseWebhookCursor("2026-10-01T00:00:00.000Z")).toThrow("non-negative integer");
});
