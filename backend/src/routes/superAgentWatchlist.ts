import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { watchChains } from "../constantineWatch.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { readyEnrollment } from "../superAgentEnrollment.js";
import { createSchedule } from "./superAgentSchedules.js";

// About a month of daily checks unless the client sets their own cap.
const DEFAULT_RUNS_CAPPED = 30;
const RUG_CHECK_SERVICE = "rug-check";

const chainKeys = Object.keys(watchChains) as [keyof typeof watchChains];

const watchInput = z.object({
  token: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Enter the token's contract address (0x and 40 characters).")
    .transform((value) => value.toLowerCase()),
  chain: z.enum(chainKeys).default("robinhood"),
  // Any enrolled agent that sells the rug-check service; Constantine unless one is named.
  agentId: z.string().uuid().optional(),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  budgetAmount: z.number().finite().positive().optional(),
  spendCap: z.number().finite().positive().optional(),
  maxRuns: z.number().int().min(1).max(1000).optional(),
  autoFund: z.boolean().default(false),
  startAt: z.string().datetime({ offset: true }).optional(),
  source: z.enum(["dashboard", "cli"]).default("dashboard"),
});

const watchColumns = `s.id, s.watch_token, s.watch_chain, s.agent_id, a.name AS agent_name, s.settlement_asset,
  s.budget_amount, s.next_run_at, s.spend_cap, s.committed_amount, s.max_runs, s.runs_count, s.auto_fund,
  s.status, s.status_reason, s.source, s.created_at, s.updated_at`;

// Each run as the schedule recorded it, with Constantine's result once the run was delivered.
const watchRuns = (limit: number) => `COALESCE((
  SELECT json_agg(r ORDER BY r.created_at DESC) FROM (
    SELECT r.id, r.slot, r.outcome, r.detail, r.created_at, r.job_id, j.status AS job_status,
      w.verdict, w.risk_score, w.baseline, COALESCE(w.changes, '[]'::jsonb) AS changes,
      w.updated_at AS checked_at
    FROM superagent_schedule_runs r
    LEFT JOIN jobs j ON j.id = r.job_id
    LEFT JOIN superagent_watch_runs w ON w.job_id = r.job_id
    WHERE r.schedule_id = s.id ORDER BY r.created_at DESC LIMIT ${limit}
  ) r), '[]'::json) AS runs`;

const withChainName = <T extends { watch_chain: keyof typeof watchChains }>(row: T) => ({
  ...row,
  chain_name: watchChains[row.watch_chain],
});

async function ownedWatch(id: string, userId: string) {
  const result = await db.query(
    `SELECT ${watchColumns}, ${watchRuns(60)} FROM superagent_schedules s JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.watch_token IS NOT NULL`,
    [id, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "watch_not_found", "This watchlist entry is not available.");
  return withChainName(result.rows[0]);
}

/**
 * Constantine's watchlist: a daily rug check on a saved token that alerts only when a signal
 * worsens. Pausing, resuming, and cancelling a watch use the schedule routes.
 */
export function registerWatchlistRoutes(router: Router) {
  router.post(
    "/watchlist",
    requireAuth,
    asyncRoute(async (request, response) => {
      const input = watchInput.parse(request.body);
      const userId = request.auth!.userId;
      const agent = await db.query<{ id: string; price_usd: string | null }>(
        `SELECT a.id, s.price_usd FROM agents a ${readyEnrollment}
         WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL AND s.slug = $1
           AND $2 = ANY(e.settlement_assets) AND ($3::uuid IS NULL OR a.id = $3)
         ORDER BY a.created_at LIMIT 1`,
        [RUG_CHECK_SERVICE, input.settlementAsset, input.agentId ?? null],
      );
      if (!agent.rowCount)
        throw new ApiError(
          404,
          "watch_agent_unavailable",
          `No rug-check agent takes ${input.settlementAsset.toUpperCase()} right now.`,
        );
      // The listed price is in USD, so it only stands in for a USDG budget.
      const listed = Number(agent.rows[0].price_usd ?? 0);
      const budget =
        input.budgetAmount ?? (input.settlementAsset === "usdg" && listed > 0 ? listed : undefined);
      if (!budget) throw new ApiError(422, "budget_required", "Set a budget for each daily check.");
      const spendCap = input.spendCap ?? budget * DEFAULT_RUNS_CAPPED;
      if (spendCap < budget)
        throw new ApiError(
          422,
          "spend_cap_too_low",
          "The spending cap must cover at least one check.",
        );
      const id = await createSchedule(userId, request.requestId, {
        agentId: agent.rows[0].id,
        request: `Watchlist check: re-check ${input.token} on ${watchChains[input.chain]} for rug-pull risk.`,
        settlementAsset: input.settlementAsset,
        budgetAmount: budget,
        cadence: "daily",
        spendCap,
        maxRuns: input.maxRuns,
        autoFund: input.autoFund,
        startAt: input.startAt,
        source: input.source,
        watch: { token: input.token, chain: input.chain },
      });
      response.status(201).json({ data: await ownedWatch(id, userId) });
    }),
  );

  router.get(
    "/watchlist",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const result = await db.query(
        `SELECT ${watchColumns}, ${watchRuns(10)} FROM superagent_schedules s JOIN agents a ON a.id = s.agent_id
         WHERE s.user_id = $1 AND s.watch_token IS NOT NULL
         ORDER BY (s.status IN ('active','paused')) DESC, s.created_at DESC LIMIT 100`,
        [request.auth!.userId],
      );
      response.json({ data: result.rows.map(withChainName) });
    }),
  );

  router.get(
    "/watchlist/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await ownedWatch(id, request.auth!.userId) });
    }),
  );
}
