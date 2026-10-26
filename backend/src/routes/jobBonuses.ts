import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { assetLabel, type SettlementAsset } from "../assets.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { transfer, userBalance } from "../ledger.js";

const decimalAmount = z
  .union([z.number(), z.string()])
  .transform((value) => String(value).trim())
  .refine((value) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(value) && Number(value) > 0, {
    message: "amount must be a positive decimal.",
  });

/**
 * Bonuses: once a delivery is accepted, its client can add a bonus for the agent's owner from
 * their available Liege balance. One per job, in the job's asset, at most the job's budget, so a
 * typo cannot send more than the work was worth.
 */
export function registerBonusRoutes(router: Router) {
  router.post(
    "/:id/bonus",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const { amount } = z.object({ amount: decimalAmount }).parse(request.body);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{
          id: string;
          title: string;
          status: string;
          client_id: string;
          agent_id: string;
          provider_id: string;
          settlement_asset: SettlementAsset;
          budget_amount: string;
        }>(
          `SELECT j.id, j.title, j.status, j.client_id, j.agent_id, a.owner_id AS provider_id,
             j.settlement_asset, j.budget_amount::text
           FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
          [jobId],
        );
        const job = found.rows[0];
        if (!job || job.client_id !== request.auth!.userId)
          throw new ApiError(404, "job_not_found", "This job does not exist.");
        if (job.status !== "completed")
          throw new ApiError(
            409,
            "bonus_not_available",
            "A bonus can be added once the delivery is accepted.",
          );
        const label = assetLabel(job.settlement_asset);
        if (Number(amount) > Number(job.budget_amount))
          throw new ApiError(
            422,
            "bonus_too_large",
            `A bonus can be at most the job's budget (${Number(job.budget_amount)} ${label}).`,
          );
        const decimals = job.settlement_asset === "liege" ? 18 : 6;
        if ((amount.split(".")[1]?.length ?? 0) > decimals)
          throw new ApiError(422, "invalid_amount", `${label} has ${decimals} decimal places.`);
        const existing = await client.query("SELECT 1 FROM job_bonuses WHERE job_id = $1", [
          job.id,
        ]);
        if (existing.rowCount)
          throw new ApiError(409, "bonus_already_added", "This job already has a bonus.");
        const [from, to] = await Promise.all([
          userBalance(client, job.client_id, "available", job.settlement_asset),
          userBalance(client, job.provider_id, "available", job.settlement_asset),
        ]);
        const ledgerTransactionId = await transfer(client, {
          reference: `job-bonus:${job.id}`,
          type: "job_bonus",
          from: from.accountId,
          to: to.accountId,
          amount,
          asset: job.settlement_asset,
          createdBy: job.client_id,
          metadata: { jobId: job.id },
          insufficientFunds: new ApiError(
            402,
            "insufficient_credits",
            `Your available ${label} balance cannot cover this bonus. Top up and try again.`,
          ),
        });
        const inserted = await client.query(
          `INSERT INTO job_bonuses (job_id, agent_id, client_id, recipient_id, asset, amount, ledger_transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING job_id, asset, trim_scale(amount)::text AS amount, created_at`,
          [
            job.id,
            job.agent_id,
            job.client_id,
            job.provider_id,
            job.settlement_asset,
            amount,
            ledgerTransactionId,
          ],
        );
        const event = await client.query<{ id: string; created_at: Date }>(
          "INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1,$2,'job.bonus_added',$3) RETURNING id, created_at",
          [job.id, job.client_id, JSON.stringify({ amount, asset: job.settlement_asset })],
        );
        await client.query(
          `INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
           VALUES ($1,$2,$3,'job.bonus_added',$4,$5,$6) ON CONFLICT (user_id, event_id) DO NOTHING`,
          [
            job.provider_id,
            job.id,
            event.rows[0].id,
            "You received a bonus",
            `The client added a ${Number(amount)} ${label} bonus for "${job.title}". It is in your available balance.`,
            event.rows[0].created_at,
          ],
        );
        await audit(client, {
          actorId: job.client_id,
          action: "job.bonus_added",
          targetType: "job",
          targetId: job.id,
          requestId: request.requestId,
          metadata: { amount, asset: job.settlement_asset },
        });
        await client.query("COMMIT");
        response.status(201).json({ data: inserted.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );
}
