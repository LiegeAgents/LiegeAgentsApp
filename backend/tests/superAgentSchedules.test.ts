import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
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
import { nextSlotAfter, processDueSchedules } from "../src/superAgentSchedules.js";

describe.skipIf(!databaseAvailable)("recurring Super Agent jobs", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  // A verified, discoverable Super Agent owned by someone else, and a client with 20 USDG.
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
    await credit(client.userId, 20);
    return { owner, client, agentId };
  }

  const schedule = (user: User, body: object) =>
    api().post("/v1/super-agents/schedules").set(bearer(user)).send(body);

  const base = (agentId: string) => ({
    agentId,
    request: "Weekly competitor brief on Solana DEXs",
    budgetAmount: 5,
    cadence: "weekly",
    spendCap: 12,
  });

  const makeDue = (id: string) =>
    db.query(
      "UPDATE superagent_schedules SET next_run_at = now() - interval '1 second' WHERE id=$1",
      [id],
    );

  const runs = async (id: string) =>
    (
      await db.query(
        "SELECT outcome, detail, job_id FROM superagent_schedule_runs WHERE schedule_id=$1 ORDER BY created_at",
        [id],
      )
    ).rows;

  test("validates the agent, budget, cap, and caller before accepting a schedule", async () => {
    const { owner, client, agentId } = await fixture();
    await api().post("/v1/super-agents/schedules").send(base(agentId)).expect(401);
    expect((await schedule(owner, base(agentId)).expect(422)).body.error.code).toBe(
      "self_hire_not_allowed",
    );
    expect(
      (await schedule(client, { ...base(agentId), budgetAmount: 50, spendCap: 100 }).expect(422))
        .body.error.code,
    ).toBe("self_evaluation_limit");
    await schedule(client, { ...base(agentId), spendCap: 4 }).expect(400);
    await schedule(client, { ...base(agentId), settlementAsset: "liege" }).expect(404);
    const created = await schedule(client, base(agentId)).expect(201);
    expect(created.body.data).toMatchObject({
      agent_name: "Research Agent",
      cadence: "weekly",
      status: "active",
      runs_count: 0,
      auto_fund: false,
      runs: [],
    });
    const cancelled = await api()
      .delete(`/v1/super-agents/schedules/${created.body.data.id}`)
      .set(bearer(client))
      .expect(200);
    expect(cancelled.body.data).toMatchObject({
      status: "cancelled",
      status_reason: "Cancelled by you.",
    });
    await makeDue(created.body.data.id);
    expect(await processDueSchedules()).toEqual([]);
  });

  test("auto-funded runs pay from the ledger, notify the agent, and stop at the spending cap", async () => {
    const { client, agentId } = await fixture();
    const id = (await schedule(client, { ...base(agentId), autoFund: true }).expect(201)).body.data
      .id;

    expect(await processDueSchedules()).toEqual([
      { scheduleId: id, outcome: "funded", jobId: expect.any(String) },
    ]);
    expect(await availableBalance(client.userId)).toBe(15);
    const [first] = await runs(id);
    const job = await db.query("SELECT status, client_id, strategy_policy FROM jobs WHERE id=$1", [
      first.job_id,
    ]);
    expect(job.rows[0]).toMatchObject({
      status: "funded",
      client_id: client.userId,
      strategy_policy: expect.objectContaining({ source: "superagent", scheduleId: id }),
    });
    const funded = await db.query(
      "SELECT count(*)::int AS count FROM webhook_events WHERE job_id=$1 AND event_type='job.funded'",
      [first.job_id],
    );
    expect(funded.rows[0].count).toBe(1);

    // Nothing is due until the next weekly slot.
    expect(await processDueSchedules()).toEqual([]);
    await makeDue(id);
    expect((await processDueSchedules())[0].outcome).toBe("funded");
    expect(await availableBalance(client.userId)).toBe(10);
    // A third 5 USDG run would exceed the 12 USDG cap, so the schedule completes.
    const done = await api()
      .get(`/v1/super-agents/schedules/${id}`)
      .set(bearer(client))
      .expect(200);
    expect(done.body.data).toMatchObject({
      status: "completed",
      status_reason: "Spending cap reached.",
      runs_count: 2,
    });
    expect(Number(done.body.data.committed_amount)).toBe(10);
    await makeDue(id);
    expect(await processDueSchedules()).toEqual([]);
  });

  test("without auto-funding a run waits for the client, and never piles up open jobs", async () => {
    const { client, agentId } = await fixture();
    const id = (await schedule(client, { ...base(agentId), spendCap: 50 }).expect(201)).body.data
      .id;
    expect((await processDueSchedules())[0].outcome).toBe("awaiting_funding");
    expect(await availableBalance(client.userId)).toBe(20);

    await makeDue(id);
    expect((await processDueSchedules())[0].outcome).toBe("skipped");
    const [open, skipped] = await runs(id);
    expect(skipped.detail).toBe("The previous run is still waiting for funding.");

    await api().post(`/v1/jobs/${open.job_id}/fund`).set(bearer(client)).send({}).expect(200);
    await makeDue(id);
    expect((await processDueSchedules())[0].outcome).toBe("awaiting_funding");
  });

  test("an auto-funded run that cannot be paid still opens the job for manual funding", async () => {
    const { client, agentId } = await fixture();
    const id = (
      await schedule(client, {
        ...base(agentId),
        budgetAmount: 25,
        spendCap: 40,
        autoFund: true,
      }).expect(201)
    ).body.data.id;
    expect((await processDueSchedules())[0].outcome).toBe("awaiting_funding");
    const [run] = await runs(id);
    expect(run.detail).toContain("balance cannot fund this job");
    expect(await availableBalance(client.userId)).toBe(20);
  });

  test("repeated failures pause the schedule; resuming re-checks the agent and skips missed slots", async () => {
    const { client, agentId } = await fixture();
    const id = (await schedule(client, base(agentId)).expect(201)).body.data.id;
    await db.query("UPDATE superagent_enrollments SET enabled=false WHERE agent_id=$1", [agentId]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await makeDue(id);
      expect((await processDueSchedules())[0].outcome).toBe("failed");
    }
    const paused = await api().get(`/v1/super-agents/schedules/${id}`).set(bearer(client));
    expect(paused.body.data.status).toBe("paused");
    expect(paused.body.data.status_reason).toContain("Paused after 3 failed runs");
    expect(paused.body.data.runs_count).toBe(0);
    await makeDue(id);
    expect(await processDueSchedules()).toEqual([]);

    await api().post(`/v1/super-agents/schedules/${id}/resume`).set(bearer(client)).expect(404);
    await db.query("UPDATE superagent_enrollments SET enabled=true WHERE agent_id=$1", [agentId]);
    const resumed = await api()
      .post(`/v1/super-agents/schedules/${id}/resume`)
      .set(bearer(client))
      .expect(200);
    expect(resumed.body.data.status).toBe("active");
    expect(new Date(resumed.body.data.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("owners can list, pause, and cancel; nobody else can see or change a schedule", async () => {
    const { client, agentId } = await fixture();
    const stranger = await signIn();
    const id = (await schedule(client, { ...base(agentId), maxRuns: 1 }).expect(201)).body.data.id;
    await api().get(`/v1/super-agents/schedules/${id}`).set(bearer(stranger)).expect(404);
    await api().post(`/v1/super-agents/schedules/${id}/pause`).set(bearer(stranger)).expect(404);
    expect(
      (await api().get("/v1/super-agents/schedules").set(bearer(stranger)).expect(200)).body.data,
    ).toEqual([]);

    await api().post(`/v1/super-agents/schedules/${id}/pause`).set(bearer(client)).expect(200);
    await makeDue(id);
    expect(await processDueSchedules()).toEqual([]);
    await api().post(`/v1/super-agents/schedules/${id}/pause`).set(bearer(client)).expect(409);
    await api().post(`/v1/super-agents/schedules/${id}/resume`).set(bearer(client)).expect(200);
    await makeDue(id);
    expect((await processDueSchedules())[0].outcome).toBe("awaiting_funding");
    const listed = await api().get("/v1/super-agents/schedules").set(bearer(client)).expect(200);
    expect(listed.body.data[0]).toMatchObject({
      id,
      status: "completed",
      status_reason: "All 1 runs were created.",
    });
    expect(listed.body.data[0].runs).toHaveLength(1);
    await api().delete(`/v1/super-agents/schedules/${id}`).set(bearer(client)).expect(409);
  });

  test("concurrent scheduler passes run each slot once", async () => {
    const { client, agentId } = await fixture();
    const id = (await schedule(client, { ...base(agentId), spendCap: 50 }).expect(201)).body.data
      .id;
    const results = await Promise.all([
      processDueSchedules(),
      processDueSchedules(),
      processDueSchedules(),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(await runs(id)).toHaveLength(1);
  });

  test("monthly slots stay anchored to the start date", async () => {
    const client = await db.connect();
    try {
      const startsAt = new Date("2027-01-31T09:00:00Z");
      const schedule = { starts_at: startsAt, cadence: "monthly" as const, next_slot: 1 };
      const first = await nextSlotAfter(client, schedule, startsAt);
      const second = await nextSlotAfter(client, { ...schedule, next_slot: 2 }, first.at);
      expect(first.at.toISOString()).toBe("2027-02-28T09:00:00.000Z");
      expect(second.at.toISOString()).toBe("2027-03-31T09:00:00.000Z");
    } finally {
      client.release();
    }
  });

  test("approving a proposal still opens the same Super Agent job", async () => {
    const { client } = await fixture();
    const proposal = await api()
      .post("/v1/super-agents/intents")
      .set(bearer(client))
      .send({ text: "Hire Research Agent for a market scan, budget 5 USDG" })
      .expect(201);
    const decided = await api()
      .post(`/v1/super-agents/intents/${proposal.body.data.id}/decision`)
      .set(bearer(client))
      .send({ decision: "approved" })
      .expect(200);
    const job = await db.query(
      "SELECT status, strategy_policy, budget_amount FROM jobs WHERE id=$1",
      [decided.body.data.job.id],
    );
    expect(job.rows[0]).toMatchObject({
      status: "open",
      strategy_policy: expect.objectContaining({
        source: "superagent",
        intentId: proposal.body.data.id,
        serviceSlug: "research-brief",
      }),
    });
    expect(Number(job.rows[0].budget_amount)).toBe(5);
  });
});
