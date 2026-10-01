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
});

test("webhook cursor parser accepts after and Last-Event-ID recovery", () => {
  expect(requestedWebhookCursor("42", "41")).toBe(42n);
  expect(requestedWebhookCursor(undefined, "41")).toBe(41n);
  expect(() => parseWebhookCursor("2026-10-01T00:00:00.000Z")).toThrow("non-negative integer");
});
