import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { revisionDeadline } from "../src/routes/jobRevisions.js";

const HOUR = 3_600_000;

test("revision time matches the original work window, between one hour and one day", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const deadlineAt = new Date("2026-10-12T12:30:00Z");
  // 30 minutes of original work → at least an hour from now.
  expect(
    revisionDeadline({ now, deadlineAt, fundedAt: new Date("2026-10-12T12:00:00Z") }).getTime(),
  ).toBe(now.getTime() + HOUR);
  // Three days of original work → capped at a day.
  expect(
    revisionDeadline({
      now,
      deadlineAt,
      fundedAt: new Date("2026-10-09T12:30:00Z"),
    }).getTime(),
  ).toBe(now.getTime() + 24 * HOUR);
  // The deadline never moves earlier.
  const later = new Date("2026-10-14T12:00:00Z");
  expect(revisionDeadline({ now, deadlineAt: later, fundedAt: null })).toEqual(later);
});

describe.skipIf(!databaseAvailable)("one revision round", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function submittedJob() {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    await credit(client.userId, 100);
    const jobId = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "First draft.", evidence: ["https://example.com/a"] })
      .expect(200);
    return { owner, client, stranger, agentId, jobId };
  }

  const revise = (token: string, jobId: string, feedback = "Add a pricing comparison.") =>
    api()
      .post(`/v1/jobs/${jobId}/revision`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ feedback });

  test("the client sends work back once; the agent revises and the job settles normally", async () => {
    const { owner, client, agentId, jobId } = await submittedJob();
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.revision_requested",
    ]);
    const before = Date.now();
    const revised = await revise(client.token, jobId).expect(200);
    expect(revised.body.data).toMatchObject({ status: "funded", revision_count: 1 });
    expect(new Date(revised.body.data.deadline_at).getTime()).toBeGreaterThanOrEqual(
      before + HOUR - 5_000,
    );
    expect(await availableBalance(client.userId)).toBe(90);

    const event = await db.query(
      `SELECT e.payload FROM webhook_events e JOIN webhook_deliveries d ON d.event_id = e.id
       WHERE e.job_id = $1 AND e.event_type = 'job.revision_requested' AND d.subscription_id = $2`,
      [jobId, hook.id],
    );
    expect(event.rows[0].payload.data).toMatchObject({ revision: 1 });

    const detail = await api().get(`/v1/jobs/${jobId}/revision`).set(bearer(owner)).expect(200);
    expect(detail.body.data).toMatchObject({
      feedback: "Add a pricing comparison.",
      previousDeliverable: "First draft.",
      previousEvidence: ["https://example.com/a"],
    });
    const job = await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200);
    expect(job.body.data.submission).toBeNull();

    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "Revised draft with pricing." })
      .expect(200);
    const latest = await api()
      .get(`/v1/jobs/${jobId}/payload/deliverable`)
      .set(bearer(client))
      .expect(200);
    expect(latest.body.data.content).toBe("Revised draft with pricing.");

    const again = await revise(client.token, jobId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("revision_limit");
    await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "Good now." })
      .expect(200);
    expect(await availableBalance(owner.userId)).toBe(10);
  });

  test("only the settler may ask, only for submitted work, and only parties may read", async () => {
    const { owner, client, stranger, jobId } = await submittedJob();
    expect((await revise(owner.token, jobId).expect(403)).body.error.code).toBe("not_client");
    await revise(stranger.token, jobId).expect(404);
    await api().get(`/v1/jobs/${jobId}/revision`).set(bearer(owner)).expect(404);
    await revise(client.token, jobId, "  ").expect(400);
    await revise(client.token, jobId).expect(200);
    await api().get(`/v1/jobs/${jobId}/revision`).set(bearer(stranger)).expect(404);
    // Back to funded: a second request has no submission to revise.
    expect((await revise(client.token, jobId).expect(409)).body.error.code).toBe(
      "invalid_job_transition",
    );
  });

  test("no revision when the job expires too soon", async () => {
    const { client, jobId } = await submittedJob();
    await db.query(
      "UPDATE jobs SET deadline_at = now() + interval '10 minutes', expires_at = now() + interval '30 minutes' WHERE id = $1",
      [jobId],
    );
    expect((await revise(client.token, jobId).expect(409)).body.error.code).toBe(
      "revision_too_late",
    );
    const job = await db.query("SELECT status FROM jobs WHERE id = $1", [jobId]);
    expect(job.rows[0].status).toBe("submitted");
  });

  test("a Super Agent runtime reads the revision but cannot request one", async () => {
    const { owner, client, agentId, jobId } = await submittedJob();
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
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,now())`,
      [agentId, service.id, hook.id],
    );
    const runtime = (
      await api().post("/v1/super-agents/runtime-token").set(bearer(owner)).expect(201)
    ).body.data.token;
    const asRuntime = { Authorization: `Bearer ${runtime}`, "x-liege-runtime-token": "1" };
    await api()
      .post(`/v1/jobs/${jobId}/revision`)
      .set(asRuntime)
      .send({ feedback: "Self-serve" })
      .expect(403);
    await revise(client.token, jobId).expect(200);
    const detail = await api().get(`/v1/jobs/${jobId}/revision`).set(asRuntime).expect(200);
    expect(detail.body.data.feedback).toBe("Add a pricing comparison.");
  });
});
