import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { nextSlotAfter, readySuperAgent, type Cadence } from "../superAgentSchedules.js";

const MAX_ACTIVE_SCHEDULES = 20;

const scheduleInput = z
  .object({
    agentId: z.string().uuid(),
    request: z.string().trim().min(1).max(10_000),
    settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
    budgetAmount: z.number().finite().positive(),
    cadence: z.enum(["daily", "weekly", "monthly"]),
    spendCap: z.number().finite().positive(),
    maxRuns: z.number().int().min(1).max(1000).optional(),
    autoFund: z.boolean().default(false),
    startAt: z.string().datetime({ offset: true }).optional(),
    source: z.enum(["dashboard", "cli"]).default("dashboard"),
  })
  .refine((input) => input.spendCap >= input.budgetAmount, {
    message: "The spending cap must cover at least one run.",
    path: ["spendCap"],
  });

const scheduleColumns = `s.id, s.agent_id, a.name AS agent_name, s.request, s.settlement_asset, s.budget_amount,
  s.cadence, s.starts_at, s.next_run_at, s.spend_cap, s.committed_amount, s.max_runs, s.runs_count,
  s.auto_fund, s.status, s.status_reason, s.source, s.created_at, s.updated_at`;

const runsFor = (limit: number) => `COALESCE((
  SELECT json_agg(r ORDER BY r.created_at DESC) FROM (
    SELECT r.id, r.slot, r.outcome, r.detail, r.created_at, r.job_id, j.status AS job_status
    FROM superagent_schedule_runs r LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.schedule_id = s.id ORDER BY r.created_at DESC LIMIT ${limit}
  ) r), '[]'::json) AS runs`;

async function ownedSchedule(id: string, userId: string) {
  const result = await db.query(
    `SELECT ${scheduleColumns}, ${runsFor(50)} FROM superagent_schedules s JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "schedule_not_found", "This recurring job is not available.");
  return result.rows[0];
}

export function registerScheduleRoutes(router: Router) {
  // Creating or resuming a schedule authorizes future spending, so it needs an operator session
  // (dashboard or linked CLI). Reading, pausing, and cancelling are also open to the companion app.
  router.post(
    "/schedules",
    requireAuth,
    asyncRoute(async (request, response) => {
      const input = scheduleInput.parse(request.body);
      const userId = request.auth!.userId;
      const startsAt = input.startAt ? new Date(input.startAt) : new Date();
      if (
        startsAt.getTime() < Date.now() - 5 * 60_000 ||
        startsAt.getTime() > Date.now() + 366 * 86_400_000
      )
        throw new ApiError(422, "invalid_start", "Start within the next year.");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Serialize per user so the active-schedule limit cannot be raced.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedules:${userId}`]);
        const active = await client.query(
          "SELECT count(*)::int AS count FROM superagent_schedules WHERE user_id=$1 AND status IN ('active','paused')",
          [userId],
        );
        if (active.rows[0].count >= MAX_ACTIVE_SCHEDULES)
          throw new ApiError(
            409,
            "schedule_limit",
            `You can keep up to ${MAX_ACTIVE_SCHEDULES} recurring jobs. Cancel one first.`,
          );
        await readySuperAgent(
          client,
          input.agentId,
          input.settlementAsset,
          userId,
          input.budgetAmount,
        );
        const created = await client.query<{ id: string }>(
          `INSERT INTO superagent_schedules (user_id, agent_id, request, settlement_asset, budget_amount, cadence,
             starts_at, next_run_at, spend_cap, max_runs, auto_fund, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING id`,
          [
            userId,
            input.agentId,
            input.request,
            input.settlementAsset,
            String(input.budgetAmount),
            input.cadence,
            startsAt,
            String(input.spendCap),
            input.maxRuns ?? null,
            input.autoFund,
            input.source,
          ],
        );
        await audit(client, {
          actorId: userId,
          action: "superagent.schedule_created",
          targetType: "superagent_schedule",
          targetId: created.rows[0].id,
          requestId: request.requestId,
          metadata: {
            agentId: input.agentId,
            cadence: input.cadence,
            budgetAmount: input.budgetAmount,
            spendCap: input.spendCap,
            autoFund: input.autoFund,
            source: input.source,
          },
        });
        await client.query("COMMIT");
        response.status(201).json({ data: await ownedSchedule(created.rows[0].id, userId) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  router.get(
    "/schedules",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const result = await db.query(
        `SELECT ${scheduleColumns}, ${runsFor(5)} FROM superagent_schedules s JOIN agents a ON a.id = s.agent_id
         WHERE s.user_id = $1 ORDER BY (s.status IN ('active','paused')) DESC, s.created_at DESC LIMIT 100`,
        [request.auth!.userId],
      );
      response.json({ data: result.rows });
    }),
  );

  router.get(
    "/schedules/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await ownedSchedule(id, request.auth!.userId) });
    }),
  );

  const changeStatus = (
    action: "pause" | "resume" | "cancel",
    from: string[],
    to: "active" | "paused" | "cancelled",
  ) =>
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{
          status: string;
          starts_at: Date;
          cadence: Cadence;
          next_slot: number;
          next_run_at: Date;
          agent_id: string;
          settlement_asset: "usdg" | "liege";
          budget_amount: string;
        }>(
          `SELECT status, starts_at, cadence, next_slot, next_run_at, agent_id, settlement_asset, budget_amount
           FROM superagent_schedules WHERE id=$1 AND user_id=$2 FOR UPDATE`,
          [id, userId],
        );
        const schedule = found.rows[0];
        if (!schedule)
          throw new ApiError(404, "schedule_not_found", "This recurring job is not available.");
        if (!from.includes(schedule.status))
          throw new ApiError(
            409,
            "invalid_schedule_transition",
            `A ${schedule.status} recurring job cannot be ${action === "cancel" ? "cancelled" : `${action}d`}.`,
          );
        let next = { slot: schedule.next_slot, at: schedule.next_run_at };
        if (action === "resume") {
          await readySuperAgent(
            client,
            schedule.agent_id,
            schedule.settlement_asset,
            userId,
            Number(schedule.budget_amount),
          );
          // Slots missed while paused are skipped, not replayed.
          if (schedule.next_run_at.getTime() <= Date.now())
            next = await nextSlotAfter(client, schedule, new Date());
        }
        await client.query(
          `UPDATE superagent_schedules SET status=$3, status_reason=$4, next_slot=$5, next_run_at=$6,
             consecutive_failures = CASE WHEN $3 = 'active' THEN 0 ELSE consecutive_failures END, updated_at=now()
           WHERE id=$1 AND user_id=$2`,
          [
            id,
            userId,
            to,
            action === "resume" ? null : `${action === "pause" ? "Paused" : "Cancelled"} by you.`,
            next.slot,
            next.at,
          ],
        );
        await audit(client, {
          actorId: userId,
          action: `superagent.schedule_${action}`,
          targetType: "superagent_schedule",
          targetId: id,
          requestId: request.requestId,
        });
        await client.query("COMMIT");
        response.json({ data: await ownedSchedule(id, userId) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });

  router.post(
    "/schedules/:id/pause",
    requireSessionOrMobileAuth("mobile:approve"),
    changeStatus("pause", ["active"], "paused"),
  );
  router.post("/schedules/:id/resume", requireAuth, changeStatus("resume", ["paused"], "active"));
  router.delete(
    "/schedules/:id",
    requireSessionOrMobileAuth("mobile:approve"),
    changeStatus("cancel", ["active", "paused"], "cancelled"),
  );
}
