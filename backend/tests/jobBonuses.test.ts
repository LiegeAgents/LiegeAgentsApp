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
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("job bonuses", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let provider: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    await credit(client.userId, 30);
  });

  async function delivered() {
    const jobId = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Report attached." })
      .expect(200);
    return jobId;
  }
  const accept = (jobId: string) =>
    api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "Great work." })
      .expect(200);
  const bonus = (user: User, jobId: string, amount: number | string) =>
    api().post(`/v1/jobs/${jobId}/bonus`).set(bearer(user)).send({ amount });

  test("after acceptance the client adds one bonus, paid to the agent's owner", async () => {
    const jobId = await delivered();
    expect((await bonus(client, jobId, 2).expect(409)).body.error.code).toBe("bonus_not_available");
    await accept(jobId);
    const added = (await bonus(client, jobId, "2.5").expect(201)).body.data;
    expect(added).toMatchObject({ amount: "2.5", asset: "usdg" });
    // 30 - 10 budget - 2.5 bonus; the owner gets the budget and the bonus.
    expect(await availableBalance(client.userId)).toBe(17.5);
    expect(await availableBalance(provider.userId)).toBe(12.5);
    expect((await bonus(client, jobId, 1).expect(409)).body.error.code).toBe("bonus_already_added");

    const note = await db.query(
      "SELECT message FROM notifications WHERE user_id = $1 AND event_type = 'job.bonus_added'",
      [provider.userId],
    );
    expect(note.rows[0].message).toContain("2.5 USDG bonus");
    const detail = (await api().get(`/v1/jobs/${jobId}`).set(bearer(provider)).expect(200)).body
      .data;
    expect(detail.bonus).toMatchObject({ amount: "2.5", asset: "usdg" });
    const slug = (await db.query("SELECT slug FROM agents WHERE id = $1", [agentId])).rows[0].slug;
    const audit = (await api().get(`/v1/agents/${slug}/reputation`).expect(200)).body.data;
    expect(audit.bonuses).toEqual({ count: 1, fromClients: 1, totalUsdg: "2.5", totalLiege: "0" });
  });

  test("only the client, within the budget and their balance", async () => {
    const jobId = await delivered();
    await accept(jobId);
    await bonus(provider, jobId, 1).expect(404);
    expect((await bonus(client, jobId, 11).expect(422)).body.error.code).toBe("bonus_too_large");
    await bonus(client, jobId, 0).expect(400);
    await bonus(client, jobId, "0.0000001").expect(422);
    // 20 left after the budget; spend most of it, then a 5 bonus cannot be covered.
    const other = await createJob(client, agentId, 18);
    await api().post(`/v1/jobs/${other}/fund`).set(bearer(client)).send({}).expect(200);
    expect((await bonus(client, jobId, 5).expect(402)).body.error.code).toBe(
      "insufficient_credits",
    );
    expect(await availableBalance(provider.userId)).toBe(10);
  });
});
