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
  type User,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { processDueSchedules } from "../src/superAgentSchedules.js";
import { compareWatchSnapshots, type WatchSnapshot } from "../src/constantineWatch.js";

const token = "0x" + "ab".repeat(20);

const clean: WatchSnapshot = {
  version: 1,
  symbol: "LIEGE",
  verdict: "No major red flags",
  riskScore: 8,
  honeypot: false,
  cannotSellAll: false,
  noSells: false,
  owner: "0x000000000000000000000000000000000000dead",
  hiddenOwner: false,
  canTakeBackOwnership: false,
  liquidityUsd: 40_000,
  lpLockedShare: 0.95,
  buyTax: 0,
  sellTax: 0.01,
  transferTax: 0,
};

describe("watchlist change rules", () => {
  test("a repeat of the same result never alerts", () => {
    expect(compareWatchSnapshots(clean, clean)).toEqual([]);
  });

  test("each worsened signal alerts once, with what changed", () => {
    const changes = compareWatchSnapshots(clean, {
      ...clean,
      honeypot: true,
      cannotSellAll: true,
      noSells: true,
      owner: "0x" + "12".repeat(20),
      hiddenOwner: true,
      canTakeBackOwnership: true,
      liquidityUsd: 19_000,
      lpLockedShare: 0.4,
      sellTax: 0.12,
      buyTax: 0.01,
    });
    expect(changes.map((change) => change.label)).toEqual([
      "Honeypot",
      "Sell limit",
      "No sells",
      "Owner changed",
      "Hidden owner",
      "Ownership can be reclaimed",
      "Liquidity pulled",
      "Liquidity unlocked",
      "Buy tax raised",
      "Sell tax raised",
    ]);
    expect(changes.find((change) => change.label === "Owner changed")?.detail).toBe(
      "Ownership moved from renounced to 0x1212…1212.",
    );
    expect(changes.find((change) => change.label === "Liquidity pulled")?.detail).toBe(
      "Pool liquidity fell from $40.0K to $19.0K.",
    );
    expect(changes.find((change) => change.label === "Sell tax raised")?.detail).toBe(
      "Sell tax rose from 1% to 12%.",
    );
  });

  test("liquidity alerts on a halving or on dropping under $5K, not on a small dip", () => {
    expect(compareWatchSnapshots(clean, { ...clean, liquidityUsd: 21_000 })).toEqual([]);
    expect(
      compareWatchSnapshots(
        { ...clean, liquidityUsd: 6_000 },
        { ...clean, liquidityUsd: 4_500 },
      ).map((change) => change.signal),
    ).toEqual(["liquidity"]);
  });

  test("a tax must rise a full percentage point", () => {
    expect(compareWatchSnapshots(clean, { ...clean, sellTax: 0.019 })).toEqual([]);
    expect(compareWatchSnapshots(clean, { ...clean, sellTax: 0.02 })).toHaveLength(1);
  });

  test("unknown fields and improvements never alert", () => {
    const unknown: WatchSnapshot = {
      ...clean,
      honeypot: null,
      cannotSellAll: null,
      noSells: null,
      owner: null,
      hiddenOwner: null,
      canTakeBackOwnership: null,
      liquidityUsd: null,
      lpLockedShare: null,
      buyTax: null,
      sellTax: null,
      transferTax: null,
    };
    expect(compareWatchSnapshots(clean, unknown)).toEqual([]);
    expect(compareWatchSnapshots(unknown, { ...clean, honeypot: true })).toEqual([]);
    const risky = { ...clean, honeypot: true, sellTax: 0.3, liquidityUsd: 1_000, owner: "" };
    expect(compareWatchSnapshots(risky, clean).map((change) => change.signal)).toEqual([
      "ownership",
    ]);
  });
});

describe.skipIf(!databaseAvailable)("Constantine watchlist", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  // A verified Super Agent selling rug checks at 2 USD, and a client with 20 USDG.
  async function fixture() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "rug-check",
          name: "Rug check",
          description: "A rug-pull risk report for one token.",
          serviceType: "skill",
          priceUsd: 2,
          slaMinutes: 30,
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

  const watch = (user: User, body: object) =>
    api().post("/v1/super-agents/watchlist").set(bearer(user)).send(body);

  const makeDue = (id: string) =>
    db.query(
      "UPDATE superagent_schedules SET next_run_at = now() - interval '1 second' WHERE id=$1",
      [id],
    );

  /** Runs the due watch and returns the job it opened. */
  async function runOnce(id: string) {
    await makeDue(id);
    const [result] = await processDueSchedules();
    expect(result).toMatchObject({ scheduleId: id, outcome: "funded" });
    return result.jobId as string;
  }

  const submit = (owner: User, jobId: string, snapshot?: WatchSnapshot) =>
    api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "# Rug check: LIEGE", ...(snapshot ? { watch: snapshot } : {}) });

  const notificationsFor = async (user: User) =>
    (
      await db.query(
        "SELECT event_type, title, message FROM notifications WHERE user_id=$1 ORDER BY created_at",
        [user.userId],
      )
    ).rows;

  test("validates the token, agent, and duplicates before watching", async () => {
    const { owner, client } = await fixture();
    await api().post("/v1/super-agents/watchlist").send({ token }).expect(401);
    await watch(client, { token: "0x1234" }).expect(400);
    await watch(client, { token, chain: "solana" }).expect(400);
    expect((await watch(owner, { token }).expect(422)).body.error.code).toBe(
      "self_hire_not_allowed",
    );
    expect(
      (await watch(client, { token, settlementAsset: "liege" }).expect(404)).body.error.code,
    ).toBe("watch_agent_unavailable");

    const created = await watch(client, { token: token.toUpperCase().replace("0X", "0x") }).expect(
      201,
    );
    expect(created.body.data).toMatchObject({
      watch_token: token,
      watch_chain: "robinhood",
      chain_name: "Robinhood Chain",
      agent_name: "Research Agent",
      budget_amount: "2.000000000000000000",
      spend_cap: "60.000000000000000000",
      status: "active",
      runs: [],
    });
    expect((await watch(client, { token }).expect(409)).body.error.code).toBe("already_watching");
    // The same token on another chain is a different watch.
    await watch(client, { token, chain: "base", budgetAmount: 1, spendCap: 3 }).expect(201);

    // A watch is a daily recurring job: the schedule routes list, pause, and cancel it.
    const schedules = (
      await api().get("/v1/super-agents/schedules").set(bearer(client)).expect(200)
    ).body.data;
    expect(schedules).toHaveLength(2);
    expect(schedules[0]).toMatchObject({ cadence: "daily", watch_token: token });
    await api()
      .delete(`/v1/super-agents/schedules/${created.body.data.id}`)
      .set(bearer(client))
      .expect(200);
    await watch(client, { token }).expect(201);
  });

  test("alerts the owner only when a signal worsens since the last check", async () => {
    const { owner, client } = await fixture();
    const id = (await watch(client, { token, autoFund: true }).expect(201)).body.data.id;

    // First check: a baseline, delivered without a "delivery submitted" ping to the client.
    const first = await runOnce(id);
    const job = await db.query("SELECT strategy_policy FROM jobs WHERE id=$1", [first]);
    expect(job.rows[0].strategy_policy).toMatchObject({
      watch: true,
      token,
      chain: "robinhood",
      scheduleId: id,
      serviceSlug: "rug-check",
    });
    await submit(owner, first, clean).expect(200);
    expect(await notificationsFor(client)).toEqual([]);

    // Second check: liquidity halves and the sell tax jumps.
    const second = await runOnce(id);
    await submit(owner, second, { ...clean, liquidityUsd: 9_000, sellTax: 0.15 }).expect(200);
    expect(await notificationsFor(client)).toEqual([
      {
        event_type: "watch.alert",
        title: "Watchlist alert: LIEGE on Robinhood Chain",
        message:
          "Pool liquidity fell from $40.0K to $9.0K. Sell tax rose from 1% to 15%. Open the run for Constantine's full report.",
      },
    ]);
    const events = await db.query(
      "SELECT payload FROM job_events WHERE job_id=$1 AND event_type='watch.alert'",
      [second],
    );
    expect(events.rows[0].payload.changes).toHaveLength(2);

    // Third check: the same risky state is old news; a failed source is not a rug either.
    const third = await runOnce(id);
    await submit(owner, third, { ...clean, liquidityUsd: null, sellTax: 0.15 }).expect(200);
    expect(await notificationsFor(client)).toHaveLength(1);

    const listed = (await api().get("/v1/super-agents/watchlist").set(bearer(client)).expect(200))
      .body.data;
    expect(listed).toHaveLength(1);
    expect(
      listed[0].runs.map((run: { baseline: boolean; changes: unknown[]; verdict: string }) => ({
        baseline: run.baseline,
        changes: run.changes.length,
        verdict: run.verdict,
      })),
    ).toEqual([
      { baseline: false, changes: 0, verdict: "No major red flags" },
      { baseline: false, changes: 2, verdict: "No major red flags" },
      { baseline: true, changes: 0, verdict: "No major red flags" },
    ]);
    const one = await api().get(`/v1/super-agents/watchlist/${id}`).set(bearer(client)).expect(200);
    expect(one.body.data.runs[1].job_status).toBe("submitted");
    await api().get(`/v1/super-agents/watchlist/${id}`).set(bearer(owner)).expect(404);

    // The stored result is encrypted, never kept in the clear.
    const stored = await db.query("SELECT snapshot_ciphertext FROM superagent_watch_runs");
    for (const row of stored.rows) expect(row.snapshot_ciphertext).not.toContain("LIEGE");

    // Accepting a clean run is the ordinary client settlement.
    await api()
      .post(`/v1/jobs/${third}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "No changes since the last check." })
      .expect(200);
  });

  test("a watch result is refused on a job that is not a watchlist run", async () => {
    const { owner, client, agentId } = await fixture();
    const id = (
      await api()
        .post("/v1/super-agents/schedules")
        .set(bearer(client))
        .send({
          agentId,
          request: "Rug check 0xabababababababababababababababababababab",
          budgetAmount: 2,
          cadence: "daily",
          spendCap: 4,
          autoFund: true,
        })
        .expect(201)
    ).body.data.id;
    const jobId = await runOnce(id);
    expect((await submit(owner, jobId, clean).expect(422)).body.error.code).toBe(
      "watch_snapshot_not_allowed",
    );
    // The delivery itself still goes through without one, and the client hears about it.
    await submit(owner, jobId).expect(200);
    expect((await notificationsFor(client)).map((row) => row.event_type)).toEqual([
      "job.submitted",
    ]);
  });
});
