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
import { adminKey } from "./setup.js";
import { releaseDuePayouts } from "../src/challenges.js";

let client: User;
let provider: User;
let admin: User;
let agentId: string;

const fund = (jobId: string) => api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({});
const submit = (jobId: string) =>
  api()
    .post(`/v1/jobs/${jobId}/submit`)
    .set(bearer(provider))
    .send({ deliverable: "Report attached." });
// No evaluator on these jobs, so the client decides them.
const decide = (jobId: string, outcome: "accepted" | "rejected") =>
  api()
    .post(`/v1/jobs/${jobId}/evaluate`)
    .set(bearer(client))
    .send({ outcome, rationale: "Checked against the criteria." });
const challenge = (user: User, jobId: string, reason = "The report misses two of the criteria.") =>
  api().post(`/v1/jobs/${jobId}/challenge`).set(bearer(user)).send({ reason });
const resolve = (disputeId: string, resolution: "upheld" | "denied") =>
  api()
    .post(`/v1/admin/disputes/${disputeId}/resolve`)
    .set(bearer(admin))
    .send({ resolution, rationale: "Reviewed the brief, criteria, and delivery." });
const job = async (jobId: string) =>
  (
    await db.query(
      "SELECT status, settled_at, payout_due_at, payout_released_at FROM jobs WHERE id = $1",
      [jobId],
    )
  ).rows[0];

/** A delivered 10 USDG job with a 24-hour window, decided by the client. */
async function decided(outcome: "accepted" | "rejected") {
  const jobId = await createJob(client, agentId, 10, { challengeWindowHours: 24 });
  await fund(jobId).expect(200);
  await submit(jobId).expect(200);
  await decide(jobId, outcome).expect(200);
  return jobId;
}

const closeWindow = (jobId: string) =>
  db.query("UPDATE jobs SET payout_due_at = now() - interval '1 second' WHERE id = $1", [jobId]);

describe.skipIf(!databaseAvailable)("challenge window", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [client, provider, admin] = await Promise.all([signIn(), signIn(), signIn(adminKey)]);
    agentId = await createAgent(provider);
    await credit(client.userId, 100);
    await credit(provider.userId, 5);
  });

  test("without a window the decision pays out at once, as before", async () => {
    const jobId = await createJob(client, agentId, 10);
    await fund(jobId).expect(200);
    await submit(jobId).expect(200);
    await decide(jobId, "accepted").expect(200);
    expect(await availableBalance(provider.userId)).toBe(15);
    expect((await job(jobId)).settled_at).not.toBeNull();
    expect((await challenge(client, jobId).expect(409)).body.error.code).toBe("not_challengeable");
  });

  test("an unchallenged decision pays out when the window closes, and not before", async () => {
    const jobId = await decided("accepted");
    expect(await job(jobId)).toMatchObject({ status: "completed", settled_at: null });
    expect(await escrowBalance(jobId)).toBe(10);
    expect(await availableBalance(provider.userId)).toBe(5);
    const window = (
      await api().get(`/v1/jobs/${jobId}/challenge`).set(bearer(provider)).expect(200)
    ).body.data;
    expect(window).toMatchObject({ windowOpen: true, bond: "1", asset: "usdg", dispute: null });

    expect(await releaseDuePayouts()).toEqual([]);
    await closeWindow(jobId);
    expect(await releaseDuePayouts()).toEqual([jobId]);
    expect(await releaseDuePayouts()).toEqual([]);
    expect(await availableBalance(provider.userId)).toBe(15);
    expect(await escrowBalance(jobId)).toBe(0);
    const settled = await job(jobId);
    expect(settled.settled_at).not.toBeNull();
    expect(settled.payout_released_at).not.toBeNull();
    expect((await challenge(client, jobId).expect(409)).body.error.code).toBe("not_challengeable");
  });

  test("only the losing side challenges, inside the window, with a bond", async () => {
    const jobId = await decided("accepted");
    // An acceptance can only be challenged by the client.
    expect((await challenge(provider, jobId).expect(403)).body.error.code).toBe("not_challenger");
    const stranger = await signIn();
    await challenge(stranger, jobId).expect(404);
    await challenge(client, jobId, "too short").expect(400);

    const opened = await challenge(client, jobId).expect(201);
    expect(opened.body.data).toMatchObject({
      decidedOutcome: "accepted",
      bond: "1",
      status: "open",
      reason: "The report misses two of the criteria.",
    });
    expect(await job(jobId)).toMatchObject({ status: "challenged", settled_at: null });
    // 100 - 10 budget - 1 bond.
    expect(await availableBalance(client.userId)).toBe(89);
    expect((await challenge(client, jobId).expect(409)).body.error.code).toBe("already_challenged");
    // A challenged job is not paid out when the window closes.
    await closeWindow(jobId);
    expect(await releaseDuePayouts()).toEqual([]);

    const late = await decided("rejected");
    await closeWindow(late);
    expect((await challenge(provider, late).expect(409)).body.error.code).toBe(
      "challenge_window_closed",
    );
  });

  test("an upheld challenge reverses the decision and returns the bond", async () => {
    const jobId = await decided("accepted");
    const disputeId = (await challenge(client, jobId).expect(201)).body.data.id;
    const listed = (await api().get("/v1/admin/disputes").set(bearer(admin)).expect(200)).body.data;
    expect(listed.map((item: { id: string }) => item.id)).toEqual([disputeId]);
    await api().get("/v1/admin/disputes").set(bearer(client)).expect(403);

    const resolved = (await resolve(disputeId, "upheld").expect(200)).body.data;
    expect(resolved).toMatchObject({ resolution: "upheld", finalOutcome: "rejected" });
    // The client gets the budget and the bond back; the provider is not paid.
    expect(await availableBalance(client.userId)).toBe(100);
    expect(await availableBalance(provider.userId)).toBe(5);
    expect(await job(jobId)).toMatchObject({ status: "rejected" });
    expect((await job(jobId)).settled_at).not.toBeNull();
    expect((await resolve(disputeId, "denied").expect(409)).body.error.code).toBe(
      "dispute_resolved",
    );
    // A lost dispute counts against the agent's record.
    const dispute = await db.query("SELECT status FROM disputes WHERE id = $1", [disputeId]);
    expect(dispute.rows[0].status).toBe("resolved_client");
  });

  test("a denied challenge keeps the decision and pays the bond to the other side", async () => {
    const jobId = await decided("rejected");
    const disputeId = (
      await challenge(provider, jobId, "Every criterion was met; see the report.").expect(201)
    ).body.data.id;
    // 5 - 1 bond.
    expect(await availableBalance(provider.userId)).toBe(4);
    await resolve(disputeId, "denied").expect(200);
    // The rejection stands: the client is refunded and also receives the bond.
    expect(await availableBalance(client.userId)).toBe(101);
    expect(await availableBalance(provider.userId)).toBe(4);
    expect(await job(jobId)).toMatchObject({ status: "rejected" });
    const shown = (await api().get(`/v1/jobs/${jobId}/challenge`).set(bearer(client)).expect(200))
      .body.data;
    expect(shown.windowOpen).toBe(false);
    expect(shown.dispute).toMatchObject({
      status: "resolved_client",
      resolution: "denied",
      rationale: "Reviewed the brief, criteria, and delivery.",
    });
  });

  test("a bond the challenger cannot cover is refused, and parties cannot arbitrate", async () => {
    const jobId = await decided("rejected");
    const poor = await signIn();
    const poorAgent = await createAgent(poor);
    const poorJob = await createJob(client, poorAgent, 10, { challengeWindowHours: 24 });
    await fund(poorJob).expect(200);
    await api()
      .post(`/v1/jobs/${poorJob}/submit`)
      .set(bearer(poor))
      .send({ deliverable: "Report attached." })
      .expect(200);
    await decide(poorJob, "rejected").expect(200);
    expect((await challenge(poor, poorJob).expect(402)).body.error.code).toBe("insufficient_bond");

    const disputeId = (await challenge(provider, jobId).expect(201)).body.data.id;
    await api()
      .post(`/v1/admin/disputes/${disputeId}/resolve`)
      .set(bearer(provider))
      .send({ resolution: "upheld", rationale: "I think I was right here." })
      .expect(403);
  });

  describe("evaluator panels", () => {
    /** Independent evaluators with the minimum USDG stake, active. */
    async function evaluators(count: number) {
      const users = await Promise.all(Array.from({ length: count }, () => signIn()));
      for (const user of users) {
        await credit(user.userId, 5000);
        await api()
          .post("/v1/admin/evaluators/stake")
          .set(bearer(admin))
          .send({ userId: user.userId, stakeUsdg: 5000, reference: `stake-${crypto.randomUUID()}` })
          .expect(200);
        await api().put("/v1/evaluators/me").set(bearer(user)).send({ active: true }).expect(200);
      }
      return users;
    }
    const vote = (user: User, disputeId: string, decision: "upheld" | "denied") =>
      api()
        .post(`/v1/disputes/${disputeId}/vote`)
        .set(bearer(user))
        .send({ decision, rationale: "Compared the delivery with each criterion." });

    test("too few eligible evaluators leaves the dispute to an arbitrator", async () => {
      await evaluators(2);
      const jobId = await decided("accepted");
      const opened = (await challenge(client, jobId).expect(201)).body.data;
      expect(opened).toMatchObject({ decidedBy: "arbitrator", panelDeadlineAt: null });
    });

    test("a drawn panel decides by majority, and its votes count toward accuracy", async () => {
      const pool = await evaluators(4);
      const jobId = await decided("accepted");
      const opened = (await challenge(client, jobId).expect(201)).body.data;
      expect(opened.decidedBy).toBe("panel");
      const members = (
        await db.query("SELECT evaluator_id FROM dispute_panel_members WHERE dispute_id = $1", [
          opened.id,
        ])
      ).rows.map((row) => row.evaluator_id);
      expect(members).toHaveLength(3);
      // Never the job's parties or its original evaluator.
      expect(members).not.toContain(client.userId);
      expect(members).not.toContain(provider.userId);
      const panel = pool.filter((user) => members.includes(user.userId));
      const outsider = pool.find((user) => !members.includes(user.userId))!;

      // Each panelist is notified and sees the case, but not how others voted.
      const inbox = await db.query(
        "SELECT user_id FROM notifications WHERE event_type = 'dispute.panel_drawn'",
      );
      expect(inbox.rows.map((row) => row.user_id).sort()).toEqual([...members].sort());
      const view = (await api().get(`/v1/disputes/${opened.id}`).set(bearer(panel[0])).expect(200))
        .body.data;
      expect(view).toMatchObject({
        decidedOutcome: "accepted",
        reason: "The report misses two of the criteria.",
        brief: "Summarize this week's market moves.",
        deliverable: "Report attached.",
        tally: null,
        myVote: null,
      });
      await api().get(`/v1/disputes/${opened.id}`).set(bearer(outsider)).expect(404);
      await vote(outsider, opened.id, "upheld").expect(404);

      // The arbitrator waits for the panel.
      expect((await resolve(opened.id, "denied").expect(409)).body.error.code).toBe(
        "panel_deciding",
      );
      const first = (await vote(panel[0], opened.id, "upheld").expect(200)).body.data;
      expect(first.resolved).toBeNull();
      expect((await vote(panel[0], opened.id, "denied").expect(409)).body.error.code).toBe(
        "already_voted",
      );
      await vote(panel[1], opened.id, "denied").expect(200);
      const third = (await vote(panel[2], opened.id, "upheld").expect(200)).body.data;
      expect(third.resolved).toMatchObject({ resolution: "upheld", finalOutcome: "rejected" });

      // Upheld: the client is refunded and gets the bond back.
      expect(await availableBalance(client.userId)).toBe(100);
      expect(await job(jobId)).toMatchObject({ status: "rejected" });
      const resolved = (
        await api().get(`/v1/disputes/${opened.id}`).set(bearer(panel[1])).expect(200)
      ).body.data;
      expect(resolved).toMatchObject({
        status: "resolved_client",
        tally: { upheld: 2, denied: 1, of: 3 },
        myVote: "denied",
      });
      const accuracy = await db.query(
        "SELECT user_id, completed_count, correct_count FROM evaluator_profiles WHERE user_id = ANY($1::uuid[])",
        [members],
      );
      const byUser = Object.fromEntries(accuracy.rows.map((row) => [row.user_id, row]));
      expect(byUser[panel[0].userId]).toMatchObject({ completed_count: 1, correct_count: 1 });
      expect(byUser[panel[1].userId]).toMatchObject({ completed_count: 1, correct_count: 0 });
      expect((await vote(panel[2], opened.id, "upheld").expect(409)).body.error.code).toBe(
        "dispute_resolved",
      );
    });

    test("after the panel's deadline an arbitrator decides and late votes are refused", async () => {
      const pool = await evaluators(3);
      const jobId = await decided("rejected");
      const opened = (await challenge(provider, jobId).expect(201)).body.data;
      expect(opened.decidedBy).toBe("panel");
      await db.query(
        "UPDATE disputes SET panel_deadline_at = now() - interval '1 second' WHERE id = $1",
        [opened.id],
      );
      expect((await vote(pool[0], opened.id, "upheld").expect(409)).body.error.code).toBe(
        "panel_closed",
      );
      await resolve(opened.id, "upheld").expect(200);
      expect(await job(jobId)).toMatchObject({ status: "completed" });
    });
  });
});
