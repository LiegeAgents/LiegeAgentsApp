import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { decryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import {
  cancelMilestonePlan,
  createMilestonePlan,
  MAX_MILESTONES,
  MIN_MILESTONES,
} from "../milestones.js";

/** Milestone escrow: a project's budget locked up front, paid one accepted milestone at a time. */
export const milestonesRouter = Router();

const planInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  brief: z.string().trim().min(1).max(10_000),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
        amount: z.number().finite().positive(),
      }),
    )
    .min(MIN_MILESTONES)
    .max(MAX_MILESTONES),
});

type PlanRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  title: string;
  brief_ciphertext: string;
  settlement_asset: string;
  total_amount: string;
  released_amount: string;
  status: string;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
  milestones: Array<{
    position: number;
    title: string;
    acceptance_criteria: string[];
    amount: string;
    job_id: string | null;
    job_status: string | null;
    started_at: string | null;
  }>;
};

const planColumns = `p.id, p.agent_id, a.name AS agent_name, p.title, p.brief_ciphertext, p.settlement_asset,
  trim_scale(p.total_amount)::text AS total_amount, trim_scale(p.released_amount)::text AS released_amount,
  p.status, p.status_reason, p.created_at, p.updated_at,
  COALESCE((SELECT json_agg(x ORDER BY x.position) FROM (
    SELECT s.position, s.title, s.acceptance_criteria, trim_scale(s.amount)::text AS amount, s.job_id,
      j.status AS job_status, s.started_at
    FROM milestone_plan_steps s LEFT JOIN jobs j ON j.id = s.job_id WHERE s.plan_id = p.id) x),
    '[]'::json) AS milestones`;

const present = (row: PlanRow) => {
  const paid = row.milestones
    .filter((step) => step.job_status === "completed")
    .reduce((sum, step) => sum + Number(step.amount), 0);
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    title: row.title,
    brief: decryptPayload(row.brief_ciphertext, payloadContext(row.id, "milestones")),
    asset: row.settlement_asset,
    total: row.total_amount,
    // Accepted milestones' budgets; what went back to the client when the plan ended.
    paid: String(+paid.toFixed(18)),
    released: row.released_amount,
    status: row.status,
    statusReason: row.status_reason,
    milestones: row.milestones.map((step) => ({
      position: step.position,
      title: step.title,
      acceptanceCriteria: step.acceptance_criteria,
      amount: step.amount,
      jobId: step.job_id,
      jobStatus: step.job_status,
      startedAt: step.started_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

async function readPlan(planId: string, userId: string) {
  const result = await db.query<PlanRow>(
    `SELECT ${planColumns} FROM milestone_plans p JOIN agents a ON a.id = p.agent_id
     WHERE p.id = $1 AND p.client_id = $2`,
    [planId, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "milestone_plan_not_found", "Milestone plan not found.");
  return present(result.rows[0]);
}

milestonesRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query<PlanRow>(
      `SELECT ${planColumns} FROM milestone_plans p JOIN agents a ON a.id = p.agent_id
       WHERE p.client_id = $1 ORDER BY (p.status = 'running') DESC, p.created_at DESC LIMIT 50`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows.map(present) });
  }),
);

milestonesRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    if (request.runtimeAuth)
      throw new ApiError(
        403,
        "runtime_scope_denied",
        "Runtime tokens cannot start milestone plans.",
      );
    const input = planInput.parse(request.body);
    const client = await db.connect();
    let planId: string;
    try {
      await client.query("BEGIN");
      planId = await createMilestonePlan(client, {
        userId: request.auth!.userId,
        agentId: input.agentId,
        title: input.title,
        brief: input.brief,
        asset: input.settlementAsset,
        milestones: input.milestones,
        requestId: request.requestId,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.status(201).json({ data: await readPlan(planId, request.auth!.userId) });
  }),
);

milestonesRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const planId = z.string().uuid().parse(request.params.id);
    response.json({ data: await readPlan(planId, request.auth!.userId) });
  }),
);

milestonesRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncRoute(async (request, response) => {
    const planId = z.string().uuid().parse(request.params.id);
    await cancelMilestonePlan(planId, request.auth!.userId, request.requestId);
    response.json({ data: await readPlan(planId, request.auth!.userId) });
  }),
);
