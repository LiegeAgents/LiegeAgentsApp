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
  escrowBalance,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

let client: User;
let provider: User;
let agentId: string;

const fund = (jobId: string) => api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({});
const submit = (jobId: string, evidence: string[] = []) =>
  api()
    .post(`/v1/jobs/${jobId}/submit`)
    .set(bearer(provider))
    .send({ deliverable: "Report attached.", evidence });
// These jobs have no evaluator, so the client settles them.
const accept = (jobId: string) =>
  api()
    .post(`/v1/jobs/${jobId}/evaluate`)
    .set(bearer(client))
    .send({ outcome: "accepted", rationale: "Meets the criteria." });
const runExpiry = (idempotencyKey: string = crypto.randomUUID()) =>
  api()
    .post("/v1/cron/expire-jobs")
    .set("x-cron-secret", process.env.CRON_SECRET!)
    .send({ idempotencyKey });
const jobStatus = async (jobId: string) =>
  (await db.query("SELECT status FROM jobs WHERE id = $1", [jobId])).rows[0].status;

// Moves a job's deadline and expiry relative to the database clock.
async function setClock(jobId: string, clock: { deadlinePassed: boolean; expired: boolean }) {
  await db.query(
    "UPDATE jobs SET deadline_at = now() + $2::interval, expires_at = now() + $3::interval WHERE id = $1",
    [jobId, clock.deadlinePassed ? "-2 hours" : "1 hour", clock.expired ? "-1 hour" : "2 hours"],
  );
}

describe.skipIf(!databaseAvailable)("job lifecycle", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    await credit(client.userId, 100);
  });

  test("simulation validates the workflow without creating or funding a job", async () => {
    const before = await db.query<{ count: string }>("SELECT count(*) FROM jobs");
    const response = await api()
      .post("/v1/jobs/simulate")
      .set(bearer(client))
      .send({
        agentId,
        title: "Preflight market summary",
        brief: "Simulate this week's market summary without storing the private brief.",
        acceptanceCriteria: ["Delivered as a written report"],
        budgetUsdg: 40,
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      })
      .expect(200);
    expect(response.body.data.mode).toBe("simulation");
    expect(response.body.data.ready).toBe(true);
    expect(response.body.data.settlement.totalEscrow).toBe("40");
    expect(response.body.data).not.toHaveProperty("brief");
    const after = await db.query<{ count: string }>("SELECT count(*) FROM jobs");
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(await availableBalance(client.userId)).toBe(100);

    const precise = await api()
      .post("/v1/jobs/simulate")
      .set(bearer(client))
      .send({
        agentId,
        title: "Precise token preflight",
        brief: "Check exact token arithmetic without creating a job.",
        acceptanceCriteria: ["Exact amount retained"],
        settlementAsset: "liege",
        budgetLiege: "0.123456789123456789",
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      })
      .expect(200);
    expect(precise.body.data.settlement.totalEscrow).toBe("0.123456789123456789");
  });

  describe("expiry", () => {
    test("refunds a funded ledger job exactly once", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);
      expect(await availableBalance(client.userId)).toBe(60);
      await setClock(jobId, { deadlinePassed: true, expired: true });

      const first = await runExpiry("expiry-run-1").expect(200);
      expect(first.body.data).toEqual({ expired: 1, refunded: 1, settlements: 0 });
      expect(first.body.replayed).toBe(false);
      expect(await jobStatus(jobId)).toBe("expired");
      expect(await availableBalance(client.userId)).toBe(100);
      expect(await escrowBalance(jobId)).toBe(0);

      const second = await runExpiry("expiry-run-2").expect(200);
      expect(second.body.data).toEqual({ expired: 0, refunded: 0, settlements: 0 });
      const replay = await runExpiry("expiry-run-1").expect(200);
      expect(replay.body.replayed).toBe(true);
      expect(await availableBalance(client.userId)).toBe(100);
    });

    test("refunds a submitted ledger job", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);
      await submit(jobId).expect(200);
      await setClock(jobId, { deadlinePassed: true, expired: true });

      await runExpiry().expect(200);
      expect(await jobStatus(jobId)).toBe("expired");
      expect(await availableBalance(client.userId)).toBe(100);
      expect(await availableBalance(provider.userId)).toBe(0);
    });

    test("expires open jobs without moving funds", async () => {
      const jobId = await createJob(client, agentId, 40);
      await setClock(jobId, { deadlinePassed: true, expired: true });

      const run = await runExpiry().expect(200);
      expect(run.body.data).toEqual({ expired: 1, refunded: 0, settlements: 0 });
      expect(await jobStatus(jobId)).toBe("expired");
      expect(await availableBalance(client.userId)).toBe(100);
    });

    test("settlement is refused once a job has expired, before the expiry job runs", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);
      await submit(jobId).expect(200);
      await setClock(jobId, { deadlinePassed: true, expired: true });

      const response = await accept(jobId).expect(409);
      expect(response.body.error.code).toBe("job_expired");
      expect(await jobStatus(jobId)).toBe("submitted");
      expect(await availableBalance(provider.userId)).toBe(0);
    });

    test("settlement racing the expiry job moves each escrow exactly once", async () => {
      const live = await createJob(client, agentId, 30);
      const lapsed = await createJob(client, agentId, 20);
      for (const jobId of [live, lapsed]) {
        await fund(jobId).expect(200);
        await submit(jobId).expect(200);
      }
      await setClock(lapsed, { deadlinePassed: true, expired: true });

      const [liveSettlement, lapsedSettlement, expiry] = await Promise.all([
        accept(live),
        accept(lapsed),
        runExpiry(),
      ]);
      expect(liveSettlement.status).toBe(200);
      expect(lapsedSettlement.status).toBe(409);
      expect(expiry.body.data).toEqual({ expired: 1, refunded: 1, settlements: 0 });
      expect(await jobStatus(live)).toBe("completed");
      expect(await jobStatus(lapsed)).toBe("expired");
      expect(await availableBalance(provider.userId)).toBe(30);
      expect(await availableBalance(client.userId)).toBe(70);
      expect((await escrowBalance(live)) + (await escrowBalance(lapsed))).toBe(0);
    });
  });

  describe("deadlines", () => {
    test("a ledger job cannot be funded after its delivery deadline", async () => {
      const jobId = await createJob(client, agentId, 40);
      await setClock(jobId, { deadlinePassed: true, expired: false });

      const response = await fund(jobId).expect(409);
      expect(response.body.error.code).toBe("job_deadline_passed");
      expect(await availableBalance(client.userId)).toBe(100);
    });

    test("work cannot be submitted after the delivery deadline", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);
      await setClock(jobId, { deadlinePassed: true, expired: false });

      const response = await submit(jobId).expect(409);
      expect(response.body.error.code).toBe("job_deadline_passed");
    });

    test("jobs must be opened with a future deadline", async () => {
      const response = await api()
        .post("/v1/jobs")
        .set(bearer(client))
        .send({
          agentId,
          title: "Market summary",
          brief: "Summarize this week's market moves.",
          acceptanceCriteria: ["Delivered as a written report"],
          budgetUsdg: 40,
          deadlineAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(400);
      expect(response.body.error.code).toBe("invalid_request");
      expect(response.body.error.fields).toContainEqual({
        path: "deadlineAt",
        message: "deadlineAt must be in the future.",
      });
    });
  });

  describe("evidence links", () => {
    test("submissions accept only https links", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);

      const unsafe = await submit(jobId, ["javascript:alert(document.cookie)"]).expect(400);
      expect(unsafe.body.error.code).toBe("invalid_request");
      await submit(jobId, ["https://example.com/report"]).expect(200);
    });

    test("stored links with other schemes are not returned", async () => {
      const jobId = await createJob(client, agentId, 40);
      await fund(jobId).expect(200);
      await submit(jobId, ["https://example.com/report"]).expect(200);
      await db.query("UPDATE submissions SET evidence = $2 WHERE job_id = $1", [
        jobId,
        JSON.stringify(["javascript:alert(1)", "data:text/html,hi", "https://example.com/report"]),
      ]);

      const response = await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200);
      expect(response.body.data.submission.evidence).toEqual(["https://example.com/report"]);
    });
  });
});
