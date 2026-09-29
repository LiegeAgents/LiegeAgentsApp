import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { settleOnchainEscrow } from "../escrow.js";
import { escrowAccount, transfer, userBalance } from "../ledger.js";

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
      // Expiry semantics, in both escrow modes: an open job holds no funds and simply expires;
      // a funded or submitted job returns its whole escrow (budget and evaluator fee) to the client.
      const funded = await client.query<{
        id: string;
        escrow_mode: "ledger" | "onchain";
        client_id: string;
        client_address: string;
        provider_address: string;
        budget_usdg: string;
        evaluator_fee_usdg: string;
      }>(`SELECT j.id, j.escrow_mode, j.client_id, c.wallet_address AS client_address, p.wallet_address AS provider_address, j.budget_usdg, j.evaluator_fee_usdg
      FROM jobs j JOIN users c ON c.id = j.client_id JOIN agents a ON a.id = j.agent_id JOIN users p ON p.id = a.owner_id
      WHERE j.status IN ('funded', 'submitted') AND j.expires_at <= now() FOR UPDATE OF j`);
      for (const job of funded.rows) {
        if (job.escrow_mode === "onchain") {
          await settleOnchainEscrow(client, {
            jobId: job.id,
            outcome: "rejected",
            clientAddress: job.client_address,
            providerAddress: job.provider_address,
            evaluatorAddress: job.client_address,
            budgetUsdg: job.budget_usdg,
            evaluatorFeeUsdg: job.evaluator_fee_usdg,
          });
        } else {
          await transfer(client, {
            reference: `job-expiry-refund:${job.id}`,
            type: "job_expiry_refund",
            from: await escrowAccount(client, job.id),
            to: (await userBalance(client, job.client_id)).accountId,
            amount: Number(job.budget_usdg) + Number(job.evaluator_fee_usdg),
            metadata: { jobId: job.id },
          });
        }
      }
      // Funded jobs are expired by id: only the rows locked and refunded above. A job funded
      // concurrently after that SELECT stays funded until the next run refunds it.
      const expired = await client.query(
        "UPDATE jobs SET status = 'expired', settled_at = now(), updated_at = now() WHERE (id = ANY($1::uuid[]) OR status = 'open') AND expires_at <= now() RETURNING id",
        [funded.rows.map((job) => job.id)],
      );
      if (expired.rowCount)
        await client.query(
          "INSERT INTO job_events (job_id, event_type) SELECT id, 'job.expired' FROM jobs WHERE id = ANY($1::uuid[])",
          [expired.rows.map((row) => row.id)],
        );
      const result = { expired: expired.rowCount ?? 0, refunded: funded.rowCount ?? 0 };
      await client.query(
        "INSERT INTO cron_runs (name, idempotency_key, result) VALUES ($1,$2,$3)",
        ["expire-jobs", idempotencyKey, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      response.json({ data: result, replayed: false });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
