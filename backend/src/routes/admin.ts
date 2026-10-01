import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireAdmin } from "../admin.js";
import { db } from "../db/index.js";
import { creditUser, setStake, userBalance } from "../ledger.js";
import { ApiError, asyncRoute } from "../http.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { ensureEscrowWallet } from "../escrow.js";
import { processSettlement } from "../settlement.js";
import { evaluatorPosition, lockEvaluator, STAKE_COVERAGE } from "../capacity.js";

const transferInput = z.object({
  userId: z.string().uuid(),
  amountUsdg: z.coerce.number().positive(),
  reference: z.string().min(8).max(200),
});
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.post(
  "/ledger/credit",
  asyncRoute(async (request, response) => {
    const input = transferInput.parse(request.body);
    if (input.amountUsdg > env.MAX_ADMIN_CREDIT_USDG)
      throw new ApiError(
        422,
        "admin_credit_call_limit",
        `A single admin credit may not exceed ${env.MAX_ADMIN_CREDIT_USDG} USDG.`,
      );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialize the daily cap check with other admin credits. Without this lock two
      // concurrent requests can both observe the same total and exceed the configured cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('liege:admin-credit-daily-cap'))");
      const creditedToday = await client.query<{ amount: string }>(
        `SELECT COALESCE(sum((metadata->>'amountUsdg')::numeric), 0) AS amount
         FROM audit_logs WHERE action = 'ledger.credited' AND created_at >= date_trunc('day', now())`,
      );
      if (Number(creditedToday.rows[0].amount) + input.amountUsdg > env.MAX_ADMIN_CREDIT_DAILY_USDG)
        throw new ApiError(
          422,
          "admin_credit_daily_limit",
          `Admin credits may not exceed ${env.MAX_ADMIN_CREDIT_DAILY_USDG} USDG per day.`,
        );
      await creditUser(
        client,
        input.userId,
        input.amountUsdg,
        request.auth!.userId,
        input.reference,
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "ledger.credited",
        targetType: "user",
        targetId: input.userId,
        requestId: request.requestId,
        metadata: { amountUsdg: input.amountUsdg, reference: input.reference },
      });
      await client.query("COMMIT");
      response.status(201).json({ data: await userBalance(client, input.userId) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

adminRouter.post(
  "/evaluators/stake",
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        userId: z.string().uuid(),
        stakeUsdg: z.coerce.number().min(0),
        reference: z.string().min(8).max(200),
      })
      .parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO evaluator_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
        [input.userId],
      );
      await lockEvaluator(client, input.userId);
      const position = await evaluatorPosition(client, input.userId, {
        stakeUsdg: input.stakeUsdg,
      });
      if (!position.covered)
        throw new ApiError(
          409,
          "stake_backs_open_jobs",
          `This evaluator's open jobs need at least ${position.exposureUsdg * STAKE_COVERAGE} USDG staked.`,
        );
      await setStake(client, input.userId, input.stakeUsdg, request.auth!.userId, input.reference);
      await client.query(
        "UPDATE evaluator_profiles SET stake_usdg = $1, updated_at = now() WHERE user_id = $2",
        [input.stakeUsdg, input.userId],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "evaluator.stake_set",
        targetType: "user",
        targetId: input.userId,
        requestId: request.requestId,
        metadata: { stakeUsdg: input.stakeUsdg, reference: input.reference },
      });
      await client.query("COMMIT");
      response.json({ data: { userId: input.userId, stakeUsdg: input.stakeUsdg } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

adminRouter.post(
  "/escrows/backfill",
  asyncRoute(async (request, response) => {
    if (env.ESCROW_MODE !== "onchain")
      throw new Error("Set ESCROW_MODE=onchain before backfilling on-chain escrow wallets.");
    const input = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.body ?? {});
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const jobs = await client.query<{ id: string }>(
        "UPDATE jobs SET escrow_mode = 'onchain', updated_at = now() WHERE id IN (SELECT id FROM jobs WHERE status = 'open' AND escrow_mode = 'ledger' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id",
        [input.limit],
      );
      const wallets = [];
      for (const job of jobs.rows)
        wallets.push({ jobId: job.id, ...(await ensureEscrowWallet(client, job.id)) });
      await client.query("COMMIT");
      response.json({ data: { backfilled: wallets.length, wallets } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

adminRouter.get(
  "/settlements",
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        status: z.enum(["pending", "failed", "complete"]).default("failed"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT es.job_id, es.outcome, es.cause, es.status, es.error, es.created_at, es.updated_at,
         COALESCE(json_agg(json_build_object('position', p.position, 'purpose', p.purpose, 'asset', p.asset,
           'recipient', p.recipient, 'amountRaw', p.amount_raw::text, 'status', p.status, 'nonce', p.nonce,
           'txHashes', p.tx_hashes, 'confirmedTxHash', p.confirmed_tx_hash, 'attempts', p.attempts,
           'lastError', p.last_error) ORDER BY p.position) FILTER (WHERE p.id IS NOT NULL), '[]') AS payouts
       FROM escrow_settlements es LEFT JOIN escrow_payouts p ON p.job_id = es.job_id
       WHERE es.status = $1 GROUP BY es.job_id ORDER BY es.updated_at LIMIT $2`,
      [query.status, query.limit],
    );
    response.json({ data: result.rows });
  }),
);

// Resumes a failed settlement once its cause is fixed (for example, a wallet short of gas).
// A reverted transfer moved nothing and spent its nonce, so it is signed again from scratch;
// any other unfinished transfer keeps its nonce, so resuming it cannot pay twice.
adminRouter.post(
  "/settlements/:jobId/retry",
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const settlement = await client.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM escrow_settlements WHERE job_id = $1 FOR UPDATE",
        [jobId],
      );
      if (!settlement.rowCount)
        throw new ApiError(404, "settlement_not_found", "This job has no on-chain settlement.");
      if (settlement.rows[0].status !== "failed")
        throw new ApiError(
          409,
          "settlement_not_failed",
          "Only a failed settlement can be retried.",
        );
      const reverted = await client.query<{ purpose: string; tx_hashes: string[] }>(
        "UPDATE escrow_payouts SET status = 'pending', nonce = NULL, signed_tx = NULL, tx_hashes = '{}', attempts = 0, updated_at = now() FROM escrow_payouts previous WHERE escrow_payouts.id = previous.id AND escrow_payouts.job_id = $1 AND escrow_payouts.status = 'reverted' RETURNING previous.purpose, previous.tx_hashes",
        [jobId],
      );
      await client.query(
        "UPDATE escrow_payouts SET attempts = 0, updated_at = now() WHERE job_id = $1 AND status IN ('pending', 'signed')",
        [jobId],
      );
      await client.query(
        "UPDATE escrow_settlements SET status = 'pending', error = NULL, lease_until = NULL, updated_at = now() WHERE job_id = $1",
        [jobId],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "escrow_settlement.retried",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
        metadata: { previousError: settlement.rows[0].error, resetRevertedPayouts: reverted.rows },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.json({ data: { jobId, status: await processSettlement(jobId) } });
  }),
);

// A late deposit can arrive after an earlier empty sweep completed. Reopen only the client-only
// client-only sweep rows; fixed provider/evaluator payouts are never recreated here.
adminRouter.post(
  "/settlements/:jobId/resweep",
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const reopened = await client.query(
        `UPDATE escrow_payouts SET status = 'pending', nonce = NULL, signed_tx = NULL, tx_hashes = '{}', amount_raw = NULL, attempts = 0, last_error = NULL, updated_at = now()
         WHERE job_id = $1 AND purpose IN ('usdg_sweep', 'token_sweep', 'eth_sweep') AND status IN ('skipped', 'confirmed') RETURNING purpose`,
        [jobId],
      );
      if (!reopened.rowCount)
        throw new ApiError(
          409,
          "resweep_unavailable",
          "No completed client sweep is available to reopen.",
        );
      await client.query(
        "UPDATE escrow_settlements SET status = 'pending', error = NULL, lease_until = NULL, updated_at = now() WHERE job_id = $1",
        [jobId],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "escrow_settlement.reswept",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
        metadata: { payouts: reopened.rows },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.json({ data: { jobId, status: await processSettlement(jobId) } });
  }),
);
