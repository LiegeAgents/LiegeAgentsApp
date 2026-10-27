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
import { ensureEscrowWallet } from "../src/escrow.js";
import { processSettlement, useEscrowChain } from "../src/settlement.js";
import { FakeChain } from "./fake-chain.js";

describe.skipIf(!databaseAvailable)("delivery promises", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let provider: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    await credit(client.userId, 100);
  });

  /** A 10 USDG job promised within an hour, funded `fundedAgo` before it is delivered now. */
  async function deliveredAfter(fundedAgo: string, extra: object = {}) {
    const jobId = await createJob(client, agentId, 10, { deliveryPromiseMinutes: 60, ...extra });
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    await db.query(`UPDATE jobs SET funded_at = now() - $2::interval WHERE id = $1`, [
      jobId,
      fundedAgo,
    ]);
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
      .send({ outcome: "accepted", rationale: "Good." })
      .expect(200);
  const lateAmount = async (jobId: string) =>
    (await db.query("SELECT late_refund_amount::text AS a FROM jobs WHERE id = $1", [jobId]))
      .rows[0].a;

  test("on time pays the full budget", async () => {
    const jobId = await deliveredAfter("50 minutes");
    await accept(jobId);
    expect(await availableBalance(provider.userId)).toBe(10);
    expect(await lateAmount(jobId)).toBeNull();
  });

  test("late refunds 10% per started hour to the client, up to half", async () => {
    // Promised in 1 hour, delivered after 3.5: 2.5 hours late, three started hours.
    const jobId = await deliveredAfter("3 hours 30 minutes");
    await accept(jobId);
    expect(await availableBalance(provider.userId)).toBe(7);
    expect(await availableBalance(client.userId)).toBe(93);
    expect(Number(await lateAmount(jobId))).toBe(3);

    const veryLate = await deliveredAfter("12 hours");
    await accept(veryLate);
    expect(Number(await lateAmount(veryLate))).toBe(5);
    expect(await availableBalance(provider.userId)).toBe(12);
  });

  test("time spent on a requested revision never counts as late", async () => {
    const jobId = await deliveredAfter("40 minutes");
    await api()
      .post(`/v1/jobs/${jobId}/revision`)
      .set(bearer(client))
      .send({ feedback: "Add a summary." })
      .expect(200);
    // The revision took hours: the job was funded five hours ago, but first delivered on time.
    await db.query(`UPDATE jobs SET funded_at = now() - interval '5 hours' WHERE id = $1;`, [
      jobId,
    ]);
    await db.query(
      `UPDATE job_revisions SET previous_submitted_at = now() - interval '4 hours 20 minutes' WHERE job_id = $1`,
      [jobId],
    );
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Revised report." })
      .expect(200);
    await accept(jobId);
    expect(await availableBalance(provider.userId)).toBe(10);
  });

  test("jobs without a promise pay in full however long they take", async () => {
    const plain = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${plain}/fund`).set(bearer(client)).send({}).expect(200);
    await db.query("UPDATE jobs SET funded_at = now() - interval '9 hours' WHERE id = $1", [plain]);
    await api()
      .post(`/v1/jobs/${plain}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Report." })
      .expect(200);
    await accept(plain);
    expect(await availableBalance(provider.userId)).toBe(10);
  });

  test("on Liege onchain escrow the late refund is a client refund in the payout plan", async () => {
    useEscrowChain(new FakeChain());
    const jobId = await createJob(client, agentId, 10, { deliveryPromiseMinutes: 60 });
    await db.query(
      "UPDATE jobs SET escrow_mode = 'onchain', status = 'funded', funded_at = now() - interval '2 hours 30 minutes' WHERE id = $1",
      [jobId],
    );
    await ensureEscrowWallet(db, jobId);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Report attached." })
      .expect(200);
    await accept(jobId);
    const plan = await db.query(
      "SELECT purpose, amount_raw FROM escrow_payouts WHERE job_id = $1 ORDER BY position",
      [jobId],
    );
    expect(plan.rows.slice(0, 2)).toEqual([
      { purpose: "provider_payment", amount_raw: "8000000" },
      { purpose: "client_refund", amount_raw: "2000000" },
    ]);
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await processSettlement(jobId);
      if (status === "complete" || status === "failed") break;
      await Bun.sleep(10);
    }
  });
});
