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
import { advanceMilestonePlans, milestoneBrief } from "../src/milestones.js";

test("a milestone's brief carries the project, the plan, and its own part", () => {
  const brief = milestoneBrief({
    brief: "Build a landing page for my app",
    steps: [{ title: "Wireframe" }, { title: "Final page" }],
    position: 1,
  });
  expect(brief).toContain("milestone 2 of 2");
  expect(brief).toContain("Build a landing page for my app");
  expect(brief).toContain("2. Final page  <- this one");
});

describe.skipIf(!databaseAvailable)("milestone escrow", () => {
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
          name: "Builder service",
          description: "Builds focused, well-organized work.",
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

  const plan = (user: User, amounts = [3, 4, 5], extra: object = {}) =>
    api()
      .post("/v1/milestones")
      .set(bearer(user))
      .send({
        agentId,
        title: "Landing page",
        brief: "Build a landing page for my note-taking app.",
        milestones: amounts.map((amount, index) => ({
          title: `Part ${index + 1}`,
          acceptanceCriteria: [`Part ${index + 1} is complete`],
          amount,
        })),
        ...extra,
      });
  const view = async (id: string) =>
    (await api().get(`/v1/milestones/${id}`).set(bearer(client)).expect(200)).body.data;
  const deliver = async (jobId: string, outcome: "accepted" | "rejected") => {
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "Done." })
      .expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome, rationale: "Checked against the criteria." })
      .expect(200);
  };
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

  test("locks the whole budget, then pays one accepted milestone at a time", async () => {
    const created = (await plan(client).expect(201)).body.data;
    expect(created).toMatchObject({ status: "running", total: "12", asset: "usdg" });
    // The first milestone is funded at once from the locked budget; the rest stays held.
    const first = created.milestones[0];
    expect(first).toMatchObject({ amount: "3", jobStatus: "funded" });
    expect(created.milestones[1].jobId).toBeNull();
    expect(await availableBalance(client.userId)).toBe(8);
    expect(await held(client.userId)).toBe(9);
    expect(await escrowBalance(first.jobId)).toBe(3);
    const job = (
      await db.query("SELECT escrow_mode, acceptance_criteria FROM jobs WHERE id = $1", [
        first.jobId,
      ])
    ).rows[0];
    expect(job).toMatchObject({
      escrow_mode: "ledger",
      acceptance_criteria: ["Part 1 is complete"],
    });

    // Nothing moves while the milestone is open.
    expect(await advanceMilestonePlans()).toEqual([]);
    await deliver(first.jobId, "accepted");
    expect(await advanceMilestonePlans()).toEqual([created.id]);
    const second = (await view(created.id)).milestones[1];
    expect(second).toMatchObject({ jobStatus: "funded" });
    expect(await held(client.userId)).toBe(5);
    expect(await availableBalance(owner.userId)).toBe(3);
    const next = await db.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND event_type = 'milestones.next'",
      [client.userId],
    );
    expect(next.rows[0].title).toBe("Milestone 2 of 3 started");

    await deliver(second.jobId, "accepted");
    await advanceMilestonePlans();
    await deliver((await view(created.id)).milestones[2].jobId, "accepted");
    await advanceMilestonePlans();
    expect(await view(created.id)).toMatchObject({
      status: "completed",
      paid: "12",
      released: "0",
    });
    expect(await availableBalance(owner.userId)).toBe(12);
    expect(await held(client.userId)).toBe(0);
    expect(await availableBalance(client.userId)).toBe(8);
  });

  test("a rejected milestone stops the plan and releases the rest", async () => {
    const created = (await plan(client).expect(201)).body.data;
    await deliver(created.milestones[0].jobId, "rejected");
    await advanceMilestonePlans();
    expect(await view(created.id)).toMatchObject({
      status: "stopped",
      statusReason: "Milestone 1 ended rejected.",
      released: "9",
    });
    // The rejected milestone is refunded, and the two that never started are released.
    expect(await availableBalance(client.userId)).toBe(20);
    expect(await held(client.userId)).toBe(0);
    const stopped = await db.query(
      "SELECT message FROM notifications WHERE user_id = $1 AND event_type = 'milestones.stopped'",
      [client.userId],
    );
    expect(stopped.rows[0].message).toContain("9 USDG");
  });

  test("cancelling releases what never started, and the running milestone finishes", async () => {
    const created = (await plan(client).expect(201)).body.data;
    const stranger = await signIn();
    await api().post(`/v1/milestones/${created.id}/cancel`).set(bearer(stranger)).expect(404);
    await api().get(`/v1/milestones/${created.id}`).set(bearer(owner)).expect(404);
    const cancelled = (
      await api().post(`/v1/milestones/${created.id}/cancel`).set(bearer(client)).expect(200)
    ).body.data;
    expect(cancelled).toMatchObject({ status: "cancelled", released: "9" });
    expect(await availableBalance(client.userId)).toBe(17);
    expect(
      (await api().post(`/v1/milestones/${created.id}/cancel`).set(bearer(client)).expect(409)).body
        .error.code,
    ).toBe("milestone_plan_ended");
    // The funded milestone still pays its agent, and the plan does not reopen.
    await deliver(created.milestones[0].jobId, "accepted");
    expect(await advanceMilestonePlans()).toEqual([]);
    expect(await availableBalance(owner.userId)).toBe(3);
    const list = (await api().get("/v1/milestones").set(bearer(client)).expect(200)).body.data;
    expect(list.map((item: { id: string }) => item.id)).toEqual([created.id]);
  });

  test("refuses plans the balance, the limits, or the rules cannot cover", async () => {
    expect((await plan(client, [10, 15]).expect(422)).body.error.code).toBe(
      "insufficient_available_balance",
    );
    await plan(client, [5]).expect(400);
    expect((await plan(owner, [1, 1]).expect(422)).body.error.code).toBe("self_hire_not_allowed");
    // Locking the budget counts as spending under the workspace's limit.
    await api()
      .put("/v1/me/spend-limits/usdg")
      .set(bearer(client))
      .send({ daily: 10, monthly: null })
      .expect(200);
    expect((await plan(client).expect(422)).body.error.code).toBe("spend_limit_reached");
    expect(await availableBalance(client.userId)).toBe(20);
    expect((await db.query("SELECT count(*)::int AS n FROM milestone_plans")).rows[0].n).toBe(0);
  });
});
