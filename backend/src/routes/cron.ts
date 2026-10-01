import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { escrowAccount, transfer, userBalance } from "../ledger.js";
import { planSettlement, processPendingSettlements } from "../settlement.js";

export const cronRouter = Router();

cronRouter.use((request, _response, next) => {
  if (!env.CRON_SECRET || request.header("x-cron-secret") !== env.CRON_SECRET)
    return next(new ApiError(401, "invalid_cron_secret", "A valid cron secret is required."));
  next();
});

cronRouter.post(
  "/expire-jobs",
  asyncRoute(async (request, response) => {
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string().min(8).max(200) })
      .parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        "SELECT result FROM cron_runs WHERE name = $1 AND idempotency_key = $2 FOR UPDATE",
        ["expire-jobs", idempotencyKey],
      );
      if (prior.rowCount) {
        await client.query("COMMIT");
        return response.json({ data: prior.rows[0].result, replayed: true });
      }
      // Expiry semantics for every escrow mode and status:
      // - ledger, open: expires; it holds no funds.
      // - ledger, funded/submitted: the whole escrow (budget and evaluator fee) returns to the client.
      // - on-chain, funded/submitted: the same, as a settlement sent after commit.
      // - on-chain, open: expires, and whatever reached its wallet (a deposit that was sent but
      //   never recorded, or the gas reserve) is swept back to the client after commit.
      const due = await client.query<{
        id: string;
        status: "open" | "funded" | "submitted";
        escrow_mode: "ledger" | "onchain";
        has_wallet: boolean;
        client_id: string;
        client_address: string;
        provider_address: string;
        settlement_asset: "usdg" | "liege";
        budget_amount: string;
        evaluator_fee_amount: string;
      }>(`SELECT j.id, j.status, j.escrow_mode, ew.job_id IS NOT NULL AS has_wallet, j.client_id, c.wallet_address AS client_address, p.wallet_address AS provider_address, j.settlement_asset, j.budget_amount, j.evaluator_fee_amount
      FROM jobs j JOIN users c ON c.id = j.client_id JOIN agents a ON a.id = j.agent_id JOIN users p ON p.id = a.owner_id
      LEFT JOIN escrow_wallets ew ON ew.job_id = j.id
      WHERE j.status IN ('open', 'funded', 'submitted') AND j.expires_at <= now()
        AND NOT (j.status = 'open' AND EXISTS (SELECT 1 FROM escrow_funding_quotes q WHERE q.job_id = j.id AND q.expires_at > now()))
      FOR UPDATE OF j`);
      let refunded = 0;
      let settlements = 0;
      for (const job of due.rows) {
        const funded = job.status !== "open";
        if (job.escrow_mode === "onchain" && (funded || job.has_wallet)) {
          await planSettlement(client, {
            jobId: job.id,
            outcome: "rejected",
            cause: "expiry",
            funded,
            clientAddress: job.client_address,
            providerAddress: job.provider_address,
            evaluatorAddress: job.client_address,
            budget: job.budget_amount,
            evaluatorFee: job.evaluator_fee_amount,
            asset: job.settlement_asset,
          });
          settlements++;
        } else if (funded) {
          await transfer(client, {
            reference: `job-expiry-refund:${job.id}`,
            type: "job_expiry_refund",
            from: await escrowAccount(client, job.id, job.settlement_asset),
            to: (await userBalance(client, job.client_id, "available", job.settlement_asset))
              .accountId,
            amount: Number(job.budget_amount) + Number(job.evaluator_fee_amount),
            asset: job.settlement_asset,
            metadata: { jobId: job.id },
          });
        }
        if (funded) refunded++;
      }
      // Only the rows locked above are expired. A job funded concurrently after that SELECT
      // stays funded until the next run refunds it.
      const expired = await client.query(
        "UPDATE jobs SET status = 'expired', settled_at = now(), updated_at = now() WHERE id = ANY($1::uuid[]) RETURNING id",
        [due.rows.map((job) => job.id)],
      );
      if (expired.rowCount)
        await client.query(
          "INSERT INTO job_events (job_id, event_type) SELECT id, 'job.expired' FROM jobs WHERE id = ANY($1::uuid[])",
          [expired.rows.map((row) => row.id)],
        );
      const result = { expired: expired.rowCount ?? 0, refunded, settlements };
      await client.query(
        "INSERT INTO cron_runs (name, idempotency_key, result) VALUES ($1,$2,$3)",
        ["expire-jobs", idempotencyKey, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      // Send the settlements just planned, along with any earlier ones still pending.
      response.json({
        data: result,
        settlements: await processPendingSettlements(),
        replayed: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

// Retries on-chain settlements that are still pending. Safe to call at any frequency.
cronRouter.post(
  "/settle-escrows",
  asyncRoute(async (_request, response) => {
    response.json({ data: await processPendingSettlements() });
  }),
);
