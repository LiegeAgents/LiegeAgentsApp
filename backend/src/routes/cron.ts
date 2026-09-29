import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { settleOnchainEscrow } from "../escrow.js";

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
      const onchain = await client.query<{
        id: string;
        client_address: string;
        provider_address: string;
        budget_usdg: string;
        evaluator_fee_usdg: string;
      }>(`SELECT j.id, c.wallet_address AS client_address, p.wallet_address AS provider_address, j.budget_usdg, j.evaluator_fee_usdg
      FROM jobs j JOIN users c ON c.id = j.client_id JOIN agents a ON a.id = j.agent_id JOIN users p ON p.id = a.owner_id
      WHERE j.escrow_mode = 'onchain' AND j.status IN ('funded', 'submitted') AND j.expires_at <= now() FOR UPDATE`);
      for (const job of onchain.rows) {
        await settleOnchainEscrow(client, {
          jobId: job.id,
          outcome: "rejected",
          clientAddress: job.client_address,
          providerAddress: job.provider_address,
          evaluatorAddress: job.client_address,
          budgetUsdg: job.budget_usdg,
          evaluatorFeeUsdg: job.evaluator_fee_usdg,
        });
      }
      const expired = await client.query(
        "UPDATE jobs SET status = 'expired', settled_at = now(), updated_at = now() WHERE (status = 'open' OR (escrow_mode = 'onchain' AND status IN ('funded', 'submitted'))) AND expires_at <= now() RETURNING id",
      );
      if (expired.rowCount)
        await client.query(
          "INSERT INTO job_events (job_id, event_type) SELECT id, 'job.expired' FROM jobs WHERE id = ANY($1::uuid[])",
          [expired.rows.map((row) => row.id)],
        );
      const result = { expired: expired.rowCount ?? 0 };
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
