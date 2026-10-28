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
  openJob,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("spend limits", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let provider: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    provider = await signIn();
    client = await signIn();
    agentId = await createAgent(provider);
    await credit(client.userId, 50);
  });

  async function fund(amount: number, status = 200) {
    const jobId = (await openJob(client, agentId, amount).expect(201)).body.data.id;
    const funded = await api()
      .post(`/v1/jobs/${jobId}/fund`)
      .set(bearer(client))
      .send({})
      .expect(status);
    return { jobId, body: funded.body };
  }
  const setLimits = (daily: number | null, monthly: number | null, asset = "usdg") =>
    api().put(`/v1/me/spend-limits/${asset}`).set(bearer(client)).send({ daily, monthly });
  const usdg = async () =>
    (await api().get("/v1/me/spend-limits").set(bearer(client)).expect(200)).body.data.find(
      (row: { asset: string }) => row.asset === "usdg",
    );

  test("a daily limit refuses the debit that would pass it, and nothing moves", async () => {
    const saved = (await setLimits(5, null).expect(200)).body.data;
    expect(saved).toMatchObject({ asset: "usdg", daily: "5", monthly: null, scheduled: null });
    await fund(3);
    const refused = await fund(3, 422);
    expect(refused.body.error.code).toBe("spend_limit_reached");
    expect(refused.body.error.message).toContain("last 24 hours to 6, over your limit of 5");
    expect(await availableBalance(client.userId)).toBe(47);
    expect((await usdg()).spent).toEqual({ day: "3", month: "3" });
    await fund(2); // exactly at the limit is allowed
  });

  test("refunds give spending back", async () => {
    await setLimits(5, null).expect(200);
    const { jobId } = await fund(4);
    await api()
      .post(`/v1/jobs/${jobId}/decline`)
      .set(bearer(provider))
      .send({ reason: "Out of scope." })
      .expect(200);
    expect((await usdg()).spent.day).toBe("0");
    await fund(5);
  });

  test("the 30-day limit counts spending older than a day", async () => {
    await setLimits(null, 5).expect(200);
    await fund(4);
    await db.query(
      "UPDATE ledger_postings SET created_at = now() - interval '3 days' WHERE created_at > now() - interval '1 minute'",
    );
    expect((await usdg()).spent).toEqual({ day: "0", month: "4" });
    expect((await fund(2, 422)).body.error.message).toContain("last 30 days");
    await db.query(
      "UPDATE ledger_postings SET created_at = now() - interval '31 days' WHERE created_at > now() - interval '4 days'",
    );
    await fund(5);
  });

  test("tightening applies now; loosening or removing waits a day", async () => {
    await setLimits(10, null).expect(200);
    const tightened = (await setLimits(3, 20).expect(200)).body.data;
    expect(tightened).toMatchObject({ daily: "3", monthly: "20", scheduled: null });

    const loosened = (await setLimits(null, 20).expect(200)).body.data;
    expect(loosened.daily).toBe("3");
    expect(loosened.scheduled).toMatchObject({ daily: null, monthly: "20" });
    expect(new Date(loosened.scheduled.at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600e3);
    await fund(4, 422);

    // A day later the removal is in force.
    await db.query("UPDATE spend_limits SET next_at = now() - interval '1 second'");
    expect(await usdg()).toMatchObject({ daily: null, monthly: "20", scheduled: null });
    await fund(4);

    // Tightening again cancels a pending loosening.
    await setLimits(null, 40).expect(200);
    const again = (await setLimits(2, 20).expect(200)).body.data;
    expect(again).toMatchObject({ daily: "2", monthly: "20", scheduled: null });
  });

  test("limits are per asset and per workspace, and inputs are checked", async () => {
    await setLimits(1, null, "liege").expect(200);
    await fund(10); // USDG has no limit
    const other = await signIn();
    await credit(other.userId, 10);
    await api()
      .put("/v1/me/spend-limits/usdg")
      .set(bearer(other))
      .send({ daily: 0, monthly: null })
      .expect(200);
    await fund(10);
    await setLimits(0, null).expect(200);
    await fund(1, 422);
    await setLimits(-1, null).expect(400);
    await api()
      .put("/v1/me/spend-limits/usdg")
      .set(bearer(client))
      .send({ daily: 1, monthly: null, weekly: 2 })
      .expect(400);
    await api()
      .put("/v1/me/spend-limits/eth")
      .set(bearer(client))
      .send({ daily: 1, monthly: null })
      .expect(400);
  });
});
