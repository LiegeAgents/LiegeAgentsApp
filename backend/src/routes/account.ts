import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { userBalance } from "../ledger.js";
import { asyncRoute } from "../http.js";
import { env } from "../config.js";
import { claimTopup, topupTokens } from "../topups.js";
import { registerTelegramAccountRoutes } from "./telegram.js";

export const accountRouter = Router();

accountRouter.get(
  "/me",
  requireAuth,
  asyncRoute(async (request, response) => {
    const user = await db.query(
      "SELECT id, wallet_address, display_name, created_at FROM users WHERE id = $1",
      [request.auth!.userId],
    );
    const client = await db.connect();
    try {
      const [available, stake, availableLiege, stakeLiege] = await Promise.all([
        userBalance(client, request.auth!.userId),
        userBalance(client, request.auth!.userId, "stake"),
        userBalance(client, request.auth!.userId, "available", "liege"),
        userBalance(client, request.auth!.userId, "stake", "liege"),
      ]);
      response.json({
        data: {
          ...user.rows[0],
          balances: {
            availableUsdg: available.amount,
            stakeUsdg: stake.amount,
            availableLiege: availableLiege.amount,
            stakeLiege: stakeLiege.amount,
          },
        },
      });
    } finally {
      client.release();
    }
  }),
);

accountRouter.get(
  "/me/ledger",
  requireAuth,
  asyncRoute(async (request, response) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    const result = await db.query(
      `SELECT lt.id, lt.reference, lt.type, lt.metadata, lt.created_at, sum(lp.amount_usdg) FILTER (WHERE la.user_id = $1) AS net_usdg
     FROM ledger_transactions lt JOIN ledger_postings lp ON lp.transaction_id = lt.id JOIN ledger_accounts la ON la.id = lp.account_id
     WHERE la.user_id = $1 GROUP BY lt.id ORDER BY lt.created_at DESC LIMIT $2`,
      [request.auth!.userId, query.limit],
    );
    response.json({ data: result.rows });
  }),
);

// Where to send a top-up, which tokens count, and the account's past top-ups.
accountRouter.get(
  "/me/topups",
  requireAuth,
  asyncRoute(async (request, response) => {
    const history = await db.query(
      `SELECT tx_hash, asset, trim_scale(amount)::text AS amount, block_number::text, created_at
       FROM ledger_topups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [request.auth!.userId],
    );
    response.json({
      data: {
        enabled: Boolean(env.TOPUP_ADDRESS),
        address: env.TOPUP_ADDRESS ?? null,
        chainId: env.RHC_ID,
        confirmations: env.TOPUP_CONFIRMATIONS,
        tokens: topupTokens(),
        topups: history.rows,
      },
    });
  }),
);

accountRouter.post(
  "/me/topups",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        asset: z.enum(["usdg", "liege"]),
      })
      .parse(request.body);
    const topup = await claimTopup({
      userId: request.auth!.userId,
      wallet: request.auth!.walletAddress,
      txHash: input.txHash,
      asset: input.asset,
    });
    response.status(topup.alreadyCredited ? 200 : 201).json({ data: topup });
  }),
);

registerTelegramAccountRoutes(accountRouter);
