import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { cancelRetainer, createRetainer, drawRetainer } from "../retainers.js";

/** Retainers: a Super Agent kept on a weekly or monthly budget that each task draws from. */
export const retainersRouter = Router();

const retainerInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  period: z.enum(["week", "month"]),
  budget: z.number().finite().positive(),
  autoRenew: z.boolean().default(true),
});

type Row = {
  id: string;
  client_id: string;
  agent_id: string;
  agent_name: string;
  agent_owner_id: string;
  title: string;
  settlement_asset: string;
  period: string;
  budget_amount: string;
  drawn: string;
  auto_renew: boolean;
  status: string;
  status_reason: string | null;
  period_number: number;
  period_started_at: Date;
  period_ends_at: Date;
  created_at: Date;
  tasks: Array<{
    job_id: string;
    title: string;
    amount: string;
    status: string;
    period_number: number;
    created_at: string;
  }>;
};

const columns = `r.id, r.client_id, r.agent_id, a.name AS agent_name, a.owner_id AS agent_owner_id, r.title,
  r.settlement_asset, r.period, trim_scale(r.budget_amount)::text AS budget_amount,
  trim_scale(COALESCE((SELECT sum(d.amount) FROM retainer_draws d
    WHERE d.retainer_id = r.id AND d.period_number = r.period_number), 0))::text AS drawn,
  r.auto_renew, r.status, r.status_reason, r.period_number, r.period_started_at, r.period_ends_at,
  r.created_at,
  COALESCE((SELECT json_agg(x ORDER BY x.created_at DESC) FROM (
    SELECT d.job_id, j.title, trim_scale(d.amount)::text AS amount, j.status, d.period_number,
      d.created_at
    FROM retainer_draws d JOIN jobs j ON j.id = d.job_id WHERE d.retainer_id = r.id
    ORDER BY d.created_at DESC LIMIT 20) x), '[]'::json) AS tasks`;

const present = (row: Row, userId: string) => ({
  id: row.id,
  // The client keeps the agent on retainer; the agent's owner sees the retainers on their agents.
  role: row.client_id === userId ? "client" : "agent",
  agentId: row.agent_id,
  agentName: row.agent_name,
  title: row.title,
  asset: row.settlement_asset,
  period: row.period,
  budget: row.budget_amount,
  drawn: row.drawn,
  left: String(Math.max(0, +(Number(row.budget_amount) - Number(row.drawn)).toFixed(18))),
  autoRenew: row.auto_renew,
  status: row.status,
  statusReason: row.status_reason,
  periodNumber: row.period_number,
  periodStartedAt: row.period_started_at,
  periodEndsAt: row.period_ends_at,
  tasks: row.tasks.map((task) => ({
    jobId: task.job_id,
    title: task.title,
    amount: task.amount,
    status: task.status,
    periodNumber: task.period_number,
    createdAt: task.created_at,
  })),
  createdAt: row.created_at,
});

async function readRetainer(id: string, userId: string) {
  const result = await db.query<Row>(
    `SELECT ${columns} FROM retainers r JOIN agents a ON a.id = r.agent_id
     WHERE r.id = $1 AND $2 IN (r.client_id, a.owner_id)`,
    [id, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "retainer_not_found", "Retainer not found.");
  return present(result.rows[0], userId);
}

retainersRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const userId = request.auth!.userId;
    const result = await db.query<Row>(
      `SELECT ${columns} FROM retainers r JOIN agents a ON a.id = r.agent_id
       WHERE $1 IN (r.client_id, a.owner_id)
       ORDER BY (r.status = 'active') DESC, r.created_at DESC LIMIT 50`,
      [userId],
    );
    response.json({ data: result.rows.map((row) => present(row, userId)) });
  }),
);

retainersRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    if (request.runtimeAuth)
      throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot start retainers.");
    const input = retainerInput.parse(request.body);
    const client = await db.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      id = await createRetainer(client, {
        userId: request.auth!.userId,
        agentId: input.agentId,
        title: input.title,
        asset: input.settlementAsset,
        period: input.period,
        budget: input.budget,
        autoRenew: input.autoRenew,
        requestId: request.requestId,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.status(201).json({ data: await readRetainer(id, request.auth!.userId) });
  }),
);

retainersRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    response.json({ data: await readRetainer(id, request.auth!.userId) });
  }),
);

retainersRouter.post(
  "/:id/tasks",
  requireAuth,
  asyncRoute(async (request, response) => {
    if (request.runtimeAuth)
      throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot draw on retainers.");
    const id = z.string().uuid().parse(request.params.id);
    const input = z
      .object({
        request: z.string().trim().min(1).max(10_000),
        amount: z.number().finite().positive(),
      })
      .parse(request.body);
    const jobId = await drawRetainer({
      retainerId: id,
      userId: request.auth!.userId,
      request: input.request,
      amount: input.amount,
      requestId: request.requestId,
    });
    response
      .status(201)
      .json({ data: { jobId, retainer: await readRetainer(id, request.auth!.userId) } });
  }),
);

retainersRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    await cancelRetainer(id, request.auth!.userId, request.requestId);
    response.json({ data: await readRetainer(id, request.auth!.userId) });
  }),
);
