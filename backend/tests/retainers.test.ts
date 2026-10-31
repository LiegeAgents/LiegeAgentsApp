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
  escrowBalance,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { rollRetainers } from "../src/retainers.js";

describe.skipIf(!databaseAvailable)("retainers", () => {
  let owner: User;
  let client: User;
  let agentId: string;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [owner, client] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: `svc-${crypto.randomUUID().slice(0, 8)}`,
          name: "Research service",
          description: "Researches and summarizes markets.",
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
  });

  const start = (user: User, extra: object = {}) =>
    api()
      .post("/v1/retainers")
      .set(bearer(user))
      .send({ agentId, title: "Weekly market notes", period: "week", budget: 10, ...extra });
  const task = (id: string, amount: number, user = client) =>
    api()
      .post(`/v1/retainers/${id}/tasks`)
      .set(bearer(user))
      .send({ request: "Summarize this week's Robinhood Chain news.", amount });
  const view = async (id: string, user = client) =>
    (await api().get(`/v1/retainers/${id}`).set(bearer(user)).expect(200)).body.data;
  const held = async (userId: string) =>
    Number(
      (
        await db.query(
          `SELECT COALESCE(sum(p.amount), 0) AS amount FROM ledger_postings p
           JOIN ledger_accounts a ON a.id = p.account_id
           WHERE a.user_id = $1 AND a.kind = 'held' AND a.asset = 'usdg'`,
          [userId],
        )
      ).rows[0].amount,
    );
  const endPeriod = (id: string) =>
    db.query("UPDATE retainers SET period_ends_at = now() - interval '1 second' WHERE id = $1", [
      id,
    ]);

  test("locks a period's budget, and each task is a job funded from it at once", async () => {
    const created = (await start(client).expect(201)).body.data;
    expect(created).toMatchObject({
      role: "client",
      budget: "10",
      drawn: "0",
      left: "10",
      status: "active",
      periodNumber: 1,
    });
    expect(await availableBalance(client.userId)).toBe(10);
    expect(await held(client.userId)).toBe(10);
    const told = await db.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND event_type = 'retainer.started'",
      [owner.userId],
    );
    expect(told.rowCount).toBe(1);

    const { jobId, retainer } = (await task(created.id, 4).expect(201)).body.data;
    expect(retainer).toMatchObject({ drawn: "4", left: "6" });
    expect(retainer.tasks[0]).toMatchObject({ jobId, amount: "4", status: "funded" });
    expect(await escrowBalance(jobId)).toBe(4);
    expect(await held(client.userId)).toBe(6);
    expect((await task(created.id, 7).expect(422)).body.error.code).toBe(
      "retainer_budget_exhausted",
    );

    // The agent's owner sees the retainer on their agent; nobody else does.
    expect(await view(created.id, owner)).toMatchObject({ role: "agent", left: "6" });
    const stranger = await signIn();
    await api().get(`/v1/retainers/${created.id}`).set(bearer(stranger)).expect(404);
    await task(created.id, 1, stranger).expect(404);
    await task(created.id, 1, owner).expect(404);

    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "Notes attached." })
      .expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "Covers the week well." })
      .expect(200);
    expect(await availableBalance(owner.userId)).toBe(4);
  });

  test("at the period's end the undrawn budget returns and the next one is locked", async () => {
    const created = (await start(client).expect(201)).body.data;
    await task(created.id, 4).expect(201);
    expect(await rollRetainers()).toEqual([]);
    await endPeriod(created.id);
    expect(await rollRetainers()).toEqual([created.id]);
    const after = await view(created.id);
    expect(after).toMatchObject({ periodNumber: 2, drawn: "0", left: "10", status: "active" });
    // 6 undrawn came back, then the next 10 was locked.
    expect(await availableBalance(client.userId)).toBe(6);
    expect(await held(client.userId)).toBe(10);
    // The next period starts where the last one ended, a week long.
    expect(new Date(after.periodEndsAt).getTime() - new Date(after.periodStartedAt).getTime()).toBe(
      7 * 86_400_000,
    );
    const renewed = await db.query(
      "SELECT message FROM notifications WHERE user_id = $1 AND event_type = 'retainer.renewed'",
      [client.userId],
    );
    expect(renewed.rows[0].message).toContain("6 USDG not used this week");
  });

  test("a retainer that cannot renew, or does not auto-renew, ends and returns the rest", async () => {
    const short = (await start(client).expect(201)).body.data;
    await task(short.id, 2).expect(201);
    // A second retainer takes the rest of the balance, so the first cannot renew.
    const other = (await start(client, { autoRenew: false, budget: 10 }).expect(201)).body.data;
    expect(await availableBalance(client.userId)).toBe(0);
    // The first rolls before the second returns its budget.
    await db.query(
      "UPDATE retainers SET period_ends_at = now() - interval '2 minutes' WHERE id = $1",
      [short.id],
    );
    await endPeriod(other.id);
    expect(await rollRetainers()).toEqual([short.id, other.id]);
    const ended = await view(short.id);
    expect(ended.status).toBe("ended");
    expect(ended.statusReason).toContain("It could not renew");
    expect((await view(other.id)).statusReason).toBe("The period ended.");
    // 8 undrawn from the first and 10 from the second came back.
    expect(await availableBalance(client.userId)).toBe(18);
    expect(await held(client.userId)).toBe(0);
    await task(short.id, 1).expect(409);
  });

  test("cancelling returns this period's undrawn budget, once", async () => {
    const created = (await start(client).expect(201)).body.data;
    await task(created.id, 3).expect(201);
    const cancelled = (
      await api().post(`/v1/retainers/${created.id}/cancel`).set(bearer(client)).expect(200)
    ).body.data;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await availableBalance(client.userId)).toBe(17);
    expect(
      (await api().post(`/v1/retainers/${created.id}/cancel`).set(bearer(client)).expect(409)).body
        .error.code,
    ).toBe("retainer_ended");
    expect((await task(created.id, 1).expect(409)).body.error.code).toBe("retainer_ended");
    const list = (await api().get("/v1/retainers").set(bearer(owner)).expect(200)).body.data;
    expect(list.map((item: { id: string }) => item.id)).toEqual([created.id]);
  });

  test("refuses retainers the balance, the limits, or the rules cannot cover", async () => {
    expect((await start(client, { budget: 25 }).expect(422)).body.error.code).toBe(
      "insufficient_available_balance",
    );
    expect((await start(owner).expect(422)).body.error.code).toBe("self_hire_not_allowed");
    await start(client, { period: "day" }).expect(400);
    await api()
      .put("/v1/me/spend-limits/usdg")
      .set(bearer(client))
      .send({ daily: 5, monthly: null })
      .expect(200);
    expect((await start(client).expect(422)).body.error.code).toBe("spend_limit_reached");
    expect(await availableBalance(client.userId)).toBe(20);
    expect((await db.query("SELECT count(*)::int AS n FROM retainers")).rows[0].n).toBe(0);
  });
});
