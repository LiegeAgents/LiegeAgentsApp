import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
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

describe.skipIf(!databaseAvailable)("live job progress", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function fundedJob() {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    await credit(client.userId, 100);
    const jobId = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    return { owner, client, stranger, agentId, jobId };
  }

  const report = (token: string, jobId: string, body: object, runtime = false) =>
    api()
      .post(`/v1/jobs/${jobId}/progress`)
      .set({
        Authorization: `Bearer ${token}`,
        ...(runtime ? { "x-liege-runtime-token": "1" } : {}),
      })
      .send(body);

  test("the agent owner reports milestones that the client sees in order", async () => {
    const { owner, client, jobId } = await fundedJob();
    await report(owner.token, jobId, {
      stage: "started",
      message: "Picked up your job",
      percent: 10,
    }).expect(201);
    await report(owner.token, jobId, { stage: "drafting", message: "Drafting the brief" }).expect(
      201,
    );
    const trail = await api().get(`/v1/jobs/${jobId}/progress`).set(bearer(client)).expect(200);
    expect(trail.body.data.map((item: { stage: string }) => item.stage)).toEqual([
      "started",
      "drafting",
    ]);
    expect(trail.body.data[0]).toMatchObject({ message: "Picked up your job", percent: 10 });
    const job = await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200);
    expect(job.body.data.progress).toHaveLength(2);
  });

  test("only the provider may report, only while funded, and only participants may read", async () => {
    const { owner, client, stranger, jobId } = await fundedJob();
    await report(client.token, jobId, { stage: "started", message: "Not mine" }).expect(404);
    await report(stranger.token, jobId, { stage: "started", message: "Not mine" }).expect(404);
    await api().get(`/v1/jobs/${jobId}/progress`).set(bearer(stranger)).expect(404);

    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "Done." })
      .expect(200);
    const late = await report(owner.token, jobId, { stage: "finalizing", message: "Too late" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("job_not_in_progress");
  });

  test("an unfunded job cannot carry progress", async () => {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const jobId = await createJob(client, await createAgent(owner), 10);
    await report(owner.token, jobId, { stage: "started", message: "Early" }).expect(409);
  });

  test("updates are validated and capped per job", async () => {
    const { owner, jobId } = await fundedJob();
    await report(owner.token, jobId, { stage: "dancing", message: "Hi" }).expect(400);
    await report(owner.token, jobId, { stage: "started", message: "x".repeat(281) }).expect(400);
    await report(owner.token, jobId, { stage: "started", message: "bell\u0007" }).expect(400);
    await report(owner.token, jobId, { stage: "started", message: "Hi", percent: 101 }).expect(400);
    for (let index = 0; index < 30; index++)
      await report(owner.token, jobId, { stage: "drafting", message: `Step ${index}` }).expect(201);
    const capped = await report(owner.token, jobId, { stage: "drafting", message: "One more" });
    expect(capped.status).toBe(409);
    expect(capped.body.error.code).toBe("progress_limit");
  });

  test("a scoped Super Agent runtime token can report for its own agents only", async () => {
    const { owner, client, agentId, jobId } = await fundedJob();
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
    await report(runtime, jobId, { stage: "drafting", message: "Drafting" }, true).expect(201);

    // Another owner's job is out of this runtime's scope.
    const otherOwner = await signIn();
    const otherJob = await createJob(client, await createAgent(otherOwner), 10);
    await api().post(`/v1/jobs/${otherJob}/fund`).set(bearer(client)).send({}).expect(200);
    await report(runtime, otherJob, { stage: "drafting", message: "Not mine" }, true).expect(403);
  });

  test("Super Agent views carry the latest milestone", async () => {
    const { owner, client, jobId } = await fundedJob();
    await db.query(
      `UPDATE jobs SET strategy_policy = '{"source":"superagent"}'::jsonb WHERE id = $1`,
      [jobId],
    );
    await report(owner.token, jobId, { stage: "started", message: "Picked up" }).expect(201);
    await report(owner.token, jobId, {
      stage: "drafting",
      message: "Drafting",
      percent: 40,
    }).expect(201);
    const dashboard = await api().get("/v1/super-agents/dashboard").set(bearer(client)).expect(200);
    expect(dashboard.body.data.jobs[0].progress).toMatchObject({
      stage: "drafting",
      message: "Drafting",
      percent: 40,
    });
  });
});
