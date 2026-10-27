import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { readMemory } from "../agentMemory.js";
import { encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

/** The client's side: see, edit, turn off, and clear what each agent remembers about them. */
export function registerMemoryRoutes(router: Router) {
  router.get(
    "/memory",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const userId = request.auth!.userId;
      // Every agent the client has hired, or written preferences for.
      const agents = await db.query<{ id: string; name: string }>(
        `SELECT DISTINCT a.id, a.name FROM agents a
         WHERE a.id IN (SELECT agent_id FROM jobs WHERE client_id = $1
                        UNION SELECT agent_id FROM agent_memory WHERE client_id = $1)
         ORDER BY a.name LIMIT 50`,
        [userId],
      );
      response.json({
        data: await Promise.all(
          agents.rows.map(async (agent) => ({
            agentId: agent.id,
            agentName: agent.name,
            ...(await readMemory(userId, agent.id)),
          })),
        ),
      });
    }),
  );

  router.put(
    "/memory/:agentId",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const agentId = z.string().uuid().parse(request.params.agentId);
      const input = z
        .object({
          preferences: z.string().trim().max(2_000).nullable().optional(),
          enabled: z.boolean().optional(),
        })
        .parse(request.body);
      const agent = await db.query("SELECT 1 FROM agents WHERE id = $1", [agentId]);
      if (!agent.rowCount) throw new ApiError(404, "agent_not_found", "Agent not found.");
      const row = (
        await db.query<{ id: string }>(
          `INSERT INTO agent_memory (client_id, agent_id) VALUES ($1,$2)
           ON CONFLICT (client_id, agent_id) DO UPDATE SET updated_at = now() RETURNING id`,
          [request.auth!.userId, agentId],
        )
      ).rows[0];
      await db.query(
        `UPDATE agent_memory SET
           preferences_ciphertext = CASE WHEN $2 THEN $3 ELSE preferences_ciphertext END,
           enabled = COALESCE($4, enabled), updated_at = now()
         WHERE id = $1`,
        [
          row.id,
          input.preferences !== undefined,
          input.preferences
            ? encryptPayload(input.preferences, payloadContext(row.id, "agent-memory"))
            : null,
          input.enabled ?? null,
        ],
      );
      response.json({ data: await readMemory(request.auth!.userId, agentId) });
    }),
  );

  router.delete(
    "/memory/:agentId",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const agentId = z.string().uuid().parse(request.params.agentId);
      await db.query(
        `INSERT INTO agent_memory (client_id, agent_id, cleared_at) VALUES ($1,$2, now())
         ON CONFLICT (client_id, agent_id) DO UPDATE SET preferences_ciphertext = NULL,
           cleared_at = now(), updated_at = now()`,
        [request.auth!.userId, agentId],
      );
      await audit(db, {
        actorId: request.auth!.userId,
        action: "agent_memory.cleared",
        targetType: "agent",
        targetId: agentId,
        requestId: request.requestId,
      });
      response.json({ data: await readMemory(request.auth!.userId, agentId) });
    }),
  );
}

/**
 * The agent's side: while working a job, its owner (or its runtime with briefs:read) reads what it
 * remembers about that job's client. The current job's own revision is not repeated here.
 */
export function registerJobMemoryRoute(router: Router) {
  router.get(
    "/:id/memory",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const found = await db.query<{
        agent_id: string;
        client_id: string;
        provider_id: string;
        status: string;
      }>(
        `SELECT j.agent_id, j.client_id, a.owner_id AS provider_id, j.status
         FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1`,
        [jobId],
      );
      const job = found.rows[0];
      if (!job || job.provider_id !== request.auth!.userId)
        throw new ApiError(404, "job_not_found", "This job is not available to this account.");
      if (
        request.runtimeAuth &&
        (!request.runtimeAuth.agentIds.includes(job.agent_id) ||
          !request.runtimeAuth.scopes.includes("briefs:read"))
      )
        throw new ApiError(403, "runtime_scope_denied", "This runtime token cannot read memory.");
      if (job.status !== "funded")
        throw new ApiError(409, "job_not_in_progress", "Memory is read while working a job.");
      response.json({ data: await readMemory(job.client_id, job.agent_id, jobId) });
    }),
  );
}
