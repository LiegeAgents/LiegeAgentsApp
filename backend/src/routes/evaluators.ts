import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../auth.js";
import { asyncRoute } from "../http.js";

const profileInput = z.object({
  specialties: z.array(z.string().min(2).max(80)).max(20).default([]),
  active: z.boolean().default(false),
});

export const evaluatorsRouter = Router();

evaluatorsRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(24),
        asset: z.enum(["usdg", "liege"]).default("usdg"),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT ep.user_id, COALESCE(sum(lp.amount), 0) AS stake_amount,
      to_char(COALESCE(sum(lp.amount), 0), 'FM999999999999999990.000000') AS stake_usdg,
      $2::text AS settlement_asset, ep.specialties, ep.completed_count, ep.correct_count, ep.created_at,
      u.wallet_address, CASE WHEN ep.completed_count = 0 THEN NULL ELSE round((ep.correct_count::numeric / ep.completed_count) * 100, 2) END AS accuracy
     FROM evaluator_profiles ep JOIN users u ON u.id = ep.user_id LEFT JOIN ledger_accounts la ON la.user_id = ep.user_id AND la.kind = 'stake'
     LEFT JOIN ledger_postings lp ON lp.account_id = la.id AND la.asset = $2
     WHERE ep.active
     GROUP BY ep.user_id, u.wallet_address, ep.specialties, ep.completed_count, ep.correct_count, ep.created_at
     HAVING COALESCE(sum(lp.amount), 0) >= 5000
     ORDER BY stake_amount DESC, ep.completed_count DESC LIMIT $1`,
      [query.limit, query.asset],
    );
    response.json({ data: result.rows });
  }),
);

evaluatorsRouter.get(
  "/me",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query("SELECT * FROM evaluator_profiles WHERE user_id = $1", [
      request.auth!.userId,
    ]);
    response.json({ data: result.rows[0] ?? null });
  }),
);

evaluatorsRouter.put(
  "/me",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = profileInput.parse(request.body);
    const result = await db.query(
      `INSERT INTO evaluator_profiles (user_id, specialties, active)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET specialties = EXCLUDED.specialties,
       active = EXCLUDED.active, updated_at = now() RETURNING *`,
      [request.auth!.userId, JSON.stringify(input.specialties), input.active],
    );
    response.json({ data: result.rows[0] });
  }),
);
