import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireAdmin } from "../admin.js";
import { db } from "../db/index.js";
import { creditUser, setStake, userBalance } from "../ledger.js";
import { asyncRoute } from "../http.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { ensureEscrowWallet } from "../escrow.js";

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
    const client = await db.connect();
    try {
      await client.query("BEGIN");
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
      const profile = await client.query("SELECT 1 FROM evaluator_profiles WHERE user_id = $1", [
        input.userId,
      ]);
      if (!profile.rowCount)
        await client.query("INSERT INTO evaluator_profiles (user_id) VALUES ($1)", [input.userId]);
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
