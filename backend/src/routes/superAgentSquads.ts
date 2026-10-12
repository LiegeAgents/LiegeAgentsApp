import { randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { latestProgressColumn } from "../jobProgress.js";
import { readySuperAgent } from "../superAgentSchedules.js";
import { MAX_SQUAD_STEPS, MIN_SQUAD_STEPS, startStep, type SquadRow } from "../superAgentSquads.js";

const MAX_RUNNING_SQUADS = 10;

const squadInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  request: z.string().trim().min(1).max(10_000),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  autoFund: z.boolean().default(false),
  source: z.enum(["dashboard", "cli"]).default("dashboard"),
  steps: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        task: z.string().trim().min(1).max(500),
        budgetAmount: z.number().finite().positive(),
      }),
    )
    .min(MIN_SQUAD_STEPS)
    .max(MAX_SQUAD_STEPS),
});

const squadColumns = `q.id, q.name, q.settlement_asset, q.total_budget, q.auto_fund, q.status, q.status_reason,
  q.source, q.created_at, q.updated_at,
  COALESCE((SELECT json_agg(x ORDER BY x.position) FROM (
    SELECT st.position, st.agent_id, a.name AS agent_name, st.task, st.budget_amount, st.job_id,
      st.detail, st.started_at, j.status AS job_status, j.public_id AS job_public_id,
      ${latestProgressColumn("j")}
    FROM superagent_squad_steps st JOIN agents a ON a.id = st.agent_id
    LEFT JOIN jobs j ON j.id = st.job_id WHERE st.squad_id = q.id) x), '[]'::json) AS steps`;

type SquadView = {
  status: string;
  status_reason: string | null;
  steps: Array<{
    position: number;
    agent_name: string;
    job_id: string | null;
    job_status: string | null;
  }>;
  [key: string]: unknown;
};

/** A running squad whose current step ended without a delivery has stopped; nothing will follow. */
function present(squad: SquadView) {
  if (squad.status !== "running") return squad;
  const started = squad.steps.filter((step) => step.job_id);
  const current = started.at(-1);
  if (current && ["rejected", "expired"].includes(String(current.job_status)))
    return {
      ...squad,
      status: "stopped",
      status_reason: `Step ${current.position + 1} (${current.agent_name}) ended without a delivery.`,
    };
  return squad;
}

async function ownedSquad(id: string, userId: string) {
  const result = await db.query<SquadView>(
    `SELECT ${squadColumns} FROM superagent_squads q WHERE q.id = $1 AND q.user_id = $2`,
    [id, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "squad_not_found", "This squad is not available.");
  return present(result.rows[0]);
}

export function registerSquadRoutes(router: Router) {
  // Approving a squad authorizes every step's spending, so it needs an operator session
  // (dashboard or linked CLI), never a runtime token.
  router.post(
    "/squads",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot start squads.");
      const input = squadInput.parse(request.body);
      const userId = request.auth!.userId;
      const total = input.steps.reduce((sum, step) => sum + step.budgetAmount, 0);
      const client = await db.connect();
      let squadId: string;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`squads:${userId}`]);
        const running = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM superagent_squads WHERE user_id=$1 AND status='running'",
          [userId],
        );
        if (running.rows[0].count >= MAX_RUNNING_SQUADS)
          throw new ApiError(
            409,
            "squad_limit",
            `You can run up to ${MAX_RUNNING_SQUADS} squads at once. Cancel one first.`,
          );
        // Every agent must be hireable now; each step checks again when it starts.
        for (const step of input.steps)
          await readySuperAgent(
            client,
            step.agentId,
            input.settlementAsset,
            userId,
            step.budgetAmount,
          );
        squadId = randomUUID();
        const created = await client.query<SquadRow>(
          `INSERT INTO superagent_squads (id, user_id, name, request_ciphertext, settlement_asset, total_budget,
             auto_fund, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, user_id, request_ciphertext, settlement_asset, auto_fund, status`,
          [
            squadId,
            userId,
            input.name ?? input.request.slice(0, 120),
            encryptPayload(input.request, payloadContext(squadId, "squad")),
            input.settlementAsset,
            String(total),
            input.autoFund,
            input.source,
          ],
        );
        for (const [position, step] of input.steps.entries())
          await client.query(
            `INSERT INTO superagent_squad_steps (squad_id, position, agent_id, task, budget_amount)
             VALUES ($1,$2,$3,$4,$5)`,
            [squadId, position, step.agentId, step.task, String(step.budgetAmount)],
          );
        await audit(client, {
          actorId: userId,
          action: "superagent.squad_created",
          targetType: "superagent_squad",
          targetId: squadId,
          requestId: request.requestId,
          metadata: {
            steps: input.steps.length,
            totalBudget: total,
            asset: input.settlementAsset,
            autoFund: input.autoFund,
            source: input.source,
          },
        });
        await startStep(client, created.rows[0], 0, []);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.status(201).json({ data: await ownedSquad(squadId, userId) });
    }),
  );

  router.get(
    "/squads",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const result = await db.query<SquadView>(
        `SELECT ${squadColumns} FROM superagent_squads q WHERE q.user_id = $1
         ORDER BY q.created_at DESC LIMIT 50`,
        [request.auth!.userId],
      );
      response.json({ data: result.rows.map(present) });
    }),
  );

  router.get(
    "/squads/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await ownedSquad(id, request.auth!.userId) });
    }),
  );

  // Cancelling stops later steps from starting. Jobs already opened keep their own lifecycle:
  // a running step can still deliver and be settled.
  router.post(
    "/squads/:id/cancel",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const result = await db.query(
        `UPDATE superagent_squads SET status='cancelled', status_reason='Cancelled by you.', updated_at=now()
         WHERE id=$1 AND user_id=$2 AND status='running' RETURNING id`,
        [id, userId],
      );
      if (!result.rowCount) {
        await ownedSquad(id, userId);
        throw new ApiError(409, "squad_not_running", "Only a running squad can be cancelled.");
      }
      await audit(db, {
        actorId: userId,
        action: "superagent.squad_cancelled",
        targetType: "superagent_squad",
        targetId: id,
        requestId: request.requestId,
      });
      response.json({ data: await ownedSquad(id, userId) });
    }),
  );
}
