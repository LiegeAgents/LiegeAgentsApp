import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
  type User,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { anchorReceipts, useReceiptAnchor } from "../src/jobReceipts.js";
import { resetLeaderboardCache } from "../src/leaderboard.js";

describe.skipIf(!databaseAvailable)("leaderboard", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    resetLeaderboardCache();
  });
  afterEach(() => useReceiptAnchor(undefined));

  const slugOf = async (id: string) =>
    (await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id=$1", [id])).rows[0].slug;

  /** Settles `count` jobs for the agent with the given outcome, delivered on time. */
  async function outcomes(client: User, agentId: string, status: string, count: number) {
    for (let i = 0; i < count; i++) {
      const jobId = await createJob(client, agentId, 5);
      await db.query(
        `UPDATE jobs SET status=$2::job_status, funded_at=now() - interval '2 hours',
           submitted_at=now() - interval '1 hour', settled_at=now() WHERE id=$1`,
        [jobId, status],
      );
    }
  }

  async function verify(owner: User, agentId: string) {
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: `service-${crypto.randomUUID().slice(0, 8)}`,
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
  }

  test("ranks by score, then recorded outcomes, and links each record to its anchored snapshot", async () => {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const [scored, busy, fresh, silent] = await Promise.all(
      [1, 2, 3, 4].map(() => createAgent(owner)),
    );
    await outcomes(client, scored, "completed", 5);
    await outcomes(client, busy, "completed", 2);
    await outcomes(client, busy, "rejected", 1);
    await verify(owner, fresh);

    const first = (await api().get("/v1/leaderboard").expect(200)).body.data;
    expect(
      first.agents.map((row: { slug: string; rank: number; score: number | null }) => [
        row.rank,
        row.slug,
        row.score,
      ]),
    ).toEqual([
      [1, await slugOf(scored), expect.any(Number)],
      [2, await slugOf(busy), null],
      [3, await slugOf(fresh), null],
    ]);
    // An agent with nothing recorded and no badge is not ranked at all.
    const silentSlug = await slugOf(silent);
    expect(first.agents.some((row: { slug: string }) => row.slug === silentSlug)).toBe(false);
    expect(first.agents).toHaveLength(3);
    expect(first.agents[1]).toMatchObject({
      outcomes: 3,
      completed: 2,
      onTimeRate: 1,
      anchored: null,
    });
    expect(first.agents[2]).toMatchObject({ verified: true, outcomes: 0 });

    // After an anchoring pass, ranked agents with outcomes link to their onchain snapshot.
    useReceiptAnchor({
      address: "0x00000000000000000000000000000000000000aa",
      send: async () => `0x${"1".padStart(64, "0")}`,
      confirm: async () => ({ status: "success", blockNumber: 77n }),
    });
    await anchorReceipts();
    await anchorReceipts();
    resetLeaderboardCache();
    const second = (await api().get("/v1/leaderboard").expect(200)).body.data;
    expect(second.agents[0].anchored).toMatchObject({
      status: "confirmed",
      txHash: `0x${"1".padStart(64, "0")}`,
      blockNumber: 77,
      score: second.agents[0].score,
    });
    expect(second.agents[1].anchored).toMatchObject({ score: null });
    expect(second.agents[2].anchored).toBeNull();
  });
});
