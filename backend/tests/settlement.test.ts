import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureEscrowWallet } from "../src/escrow.js";
import { planSettlement, processSettlement, useEscrowChain } from "../src/settlement.js";
import { FakeChain, GAS_COST } from "./fake-chain.js";
import { adminKey } from "./setup.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  databaseAvailable,
  db,
  inTransaction,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

const USDG = 1_000_000n;
const GAS_RESERVE = 100_000n;
const DEPOSIT = { usdg: 45n * USDG, eth: GAS_RESERVE };

let chain: FakeChain;
let client: User;
let provider: User;
let evaluator: User;
let agentId: string;

// A 40 USDG job with a 5 USDG evaluator fee, moved to on-chain escrow with a funded wallet.
async function onchainJob(status: "open" | "funded", deposit = DEPOSIT) {
  const jobId = await createJob(client, agentId, 40);
  await db.query(
    "UPDATE jobs SET escrow_mode = 'onchain', status = $2, evaluator_id = $3, evaluator_fee_usdg = 5 WHERE id = $1",
    [jobId, status, evaluator.userId],
  );
  const { address } = await ensureEscrowWallet(db, jobId);
  chain.credit(address, deposit);
  return { jobId, wallet: address };
}

const planAcceptance = (jobId: string) =>
  inTransaction((transaction) =>
    planSettlement(transaction, {
      jobId,
      outcome: "accepted",
      cause: "evaluation",
      funded: true,
      clientAddress: client.address,
      providerAddress: provider.address,
      evaluatorAddress: evaluator.address,
      budgetUsdg: "40",
      evaluatorFeeUsdg: "5",
    }),
  );

// Runs the settlement until it finishes, as repeated cron calls would.
async function settle(jobId: string) {
  for (let run = 0, waits = 0; run < 12 && waits < 200;) {
    const status = await processSettlement(jobId);
    if (status === "complete" || status === "failed") return status;
    // Another worker (such as the one the evaluate route starts) holds the lease.
    if (status === "busy") {
      waits++;
      await Bun.sleep(10);
    } else run++;
  }
  return "pending";
}

// Successful transfers out of a wallet, in order.
const paid = (wallet: string) =>
  chain.mined
    .filter((transaction) => transaction.from === wallet && transaction.status === "success")
    .map((transaction) => [transaction.asset, transaction.to, BigInt(transaction.amount)]);

const acceptedPayouts = (gasSpent: bigint) => [
  ["usdg", provider.address, 40n * USDG],
  ["usdg", evaluator.address, 5n * USDG],
  // The sweep pays its own gas too.
  ["eth", client.address, GAS_RESERVE - gasSpent - GAS_COST],
];

describe.skipIf(!databaseAvailable)("on-chain escrow settlement", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    chain = new FakeChain();
    useEscrowChain(chain);
    [client, provider, evaluator] = await Promise.all([signIn(), signIn(), signIn()]);
    agentId = await createAgent(provider);
  });

  test("an evaluation commits the outcome, then pays each party once", async () => {
    const { jobId, wallet } = await onchainJob("funded");
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Report attached." })
      .expect(200);
    const evaluated = await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(evaluator))
      .send({ outcome: "accepted", rationale: "Meets the criteria." })
      .expect(200);
    expect(evaluated.body.data.status).toBe("completed");

    expect(await settle(jobId)).toBe("complete");
    expect(paid(wallet)).toEqual(acceptedPayouts(2n * GAS_COST));
    expect(chain.balanceOf(wallet)).toEqual({ usdg: 0n, eth: 0n });
    const job = await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200);
    expect(job.body.data.settlement_status).toBe("complete");
  });

  test("a failure before or after any chain call never pays twice or strands funds", async () => {
    const clean = await onchainJob("funded");
    await planAcceptance(clean.jobId);
    chain.calls = 0;
    expect(await settle(clean.jobId)).toBe("complete");
    const callsInCleanRun = chain.calls;
    expect(callsInCleanRun).toBeGreaterThan(10);

    for (let call = 0; call < callsInCleanRun; call++)
      for (const when of ["before", "after"] as const) {
        const { jobId, wallet } = await onchainJob("funded");
        await planAcceptance(jobId);
        chain.failAt(call, when);
        expect(await settle(jobId)).toBe("complete");
        expect({ call, when, paid: paid(wallet) }).toEqual({
          call,
          when,
          paid: acceptedPayouts(2n * GAS_COST),
        });
        expect(chain.balanceOf(wallet)).toEqual({ usdg: 0n, eth: 0n });
      }
  }, 60_000);

  test("concurrent workers send each transfer once", async () => {
    const { jobId, wallet } = await onchainJob("funded");
    await planAcceptance(jobId);
    await Promise.all([processSettlement(jobId), processSettlement(jobId), settle(jobId)]);
    expect(await settle(jobId)).toBe("complete");
    expect(paid(wallet)).toEqual(acceptedPayouts(2n * GAS_COST));
  });

  test("a reverted transfer halts the settlement until an administrator retries it", async () => {
    const admin = await signIn(adminKey);
    const { jobId, wallet } = await onchainJob("funded", { usdg: 10n * USDG, eth: GAS_RESERVE });
    await planAcceptance(jobId);
    expect(await settle(jobId)).toBe("failed");
    expect(paid(wallet)).toEqual([]);

    const failed = await api().get("/v1/admin/settlements").set(bearer(admin)).expect(200);
    expect(failed.body.data).toHaveLength(1);
    expect(failed.body.data[0].payouts[0]).toMatchObject({
      purpose: "provider_payment",
      status: "reverted",
    });

    chain.credit(wallet, { usdg: 35n * USDG });
    const retried = await api()
      .post(`/v1/admin/settlements/${jobId}/retry`)
      .set(bearer(admin))
      .expect(200);
    expect(retried.body.data.status).toBe("complete");
    // The reverted transaction moved nothing but spent gas.
    expect(paid(wallet)).toEqual(acceptedPayouts(3n * GAS_COST));
    const logged = await db.query("SELECT 1 FROM audit_logs WHERE action = $1 AND target_id = $2", [
      "escrow_settlement.retried",
      jobId,
    ]);
    expect(logged.rowCount).toBe(1);
    await api().post(`/v1/admin/settlements/${jobId}/retry`).set(bearer(admin)).expect(409);
  });

  test("a transfer whose nonce was spent elsewhere is never signed again", async () => {
    const { jobId, wallet } = await onchainJob("funded");
    await planAcceptance(jobId);
    chain.holdBroadcasts = true;
    expect(await processSettlement(jobId)).toBe("pending");
    chain.holdBroadcasts = false;
    chain.spendNonce(wallet);

    expect(await settle(jobId)).toBe("failed");
    const payout = await db.query(
      "SELECT status, tx_hashes, last_error FROM escrow_payouts WHERE job_id = $1 AND position = 0",
      [jobId],
    );
    expect(payout.rows[0].status).toBe("signed");
    expect(payout.rows[0].tx_hashes).toHaveLength(1);
    expect(payout.rows[0].last_error).toContain("Nonce 0 was used");
    expect(paid(wallet)).toEqual([]);
  });

  test("expiry refunds funded jobs and returns unrecorded deposits from open ones", async () => {
    const funded = await onchainJob("funded");
    const open = await onchainJob("open", { usdg: 0n, eth: GAS_RESERVE });
    await db.query(
      "UPDATE jobs SET deadline_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])",
      [[funded.jobId, open.jobId]],
    );

    const run = await api()
      .post("/v1/cron/expire-jobs")
      .set("x-cron-secret", process.env.CRON_SECRET!)
      .send({ idempotencyKey: crypto.randomUUID() })
      .expect(200);
    expect(run.body.data).toEqual({ expired: 2, refunded: 1, settlements: 2 });
    expect(run.body.settlements).toEqual({ complete: 2, pending: 0, failed: 0, busy: 0 });
    expect(paid(funded.wallet)).toEqual([
      ["usdg", client.address, 45n * USDG],
      ["eth", client.address, GAS_RESERVE - 2n * GAS_COST],
    ]);
    expect(paid(open.wallet)).toEqual([["eth", client.address, GAS_RESERVE - GAS_COST]]);
  });

  test("the signer refuses transfers that do not match the job's terms", async () => {
    const attacker = `0x${"9".repeat(40)}`;
    const tampering = [
      (jobId: string) =>
        db.query(
          "UPDATE escrow_payouts SET recipient = $2 WHERE job_id = $1 AND purpose = 'provider_payment'",
          [jobId, attacker],
        ),
      (jobId: string) =>
        db.query(
          "UPDATE escrow_payouts SET amount_raw = amount_raw * 2 WHERE job_id = $1 AND purpose = 'provider_payment'",
          [jobId],
        ),
      (jobId: string) =>
        db.query(
          "UPDATE escrow_payouts SET recipient = $2 WHERE job_id = $1 AND purpose = 'eth_sweep'",
          [jobId, attacker],
        ),
    ];
    for (const [index, tamper] of tampering.entries()) {
      const { jobId, wallet } = await onchainJob("funded");
      await planAcceptance(jobId);
      await tamper(jobId);
      expect({ index, status: await processSettlement(jobId) }).toEqual({
        index,
        status: "failed",
      });
      const settlement = await db.query("SELECT error FROM escrow_settlements WHERE job_id = $1", [
        jobId,
      ]);
      expect(settlement.rows[0].error).toContain("Signing policy refused");
      expect(chain.mined.filter((transaction) => transaction.to === attacker)).toEqual([]);
      if (index < 2) expect(paid(wallet)).toEqual([]);
    }
  });

  test("every signature is logged before its transaction is broadcast", async () => {
    const { jobId, wallet } = await onchainJob("funded");
    await planAcceptance(jobId);
    // The first broadcast fails before sending, so that transfer is signed a second time.
    chain.failAt(2, "before");
    expect(await settle(jobId)).toBe("complete");
    const logged = await db.query(
      "SELECT metadata->>'txHash' AS hash FROM audit_logs WHERE action = 'escrow.transfer_signed' AND target_id = $1",
      [jobId],
    );
    const loggedHashes = logged.rows.map((row) => row.hash);
    const minedHashes = chain.mined
      .filter((transaction) => transaction.from === wallet)
      .map((transaction) => transaction.hash);
    for (const hash of minedHashes) expect(loggedHashes).toContain(hash);
    expect(loggedHashes).toHaveLength(minedHashes.length + 1);
  });
});
