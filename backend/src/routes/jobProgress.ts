import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { MAX_PROGRESS_UPDATES } from "../jobProgress.js";

const progressInput = z.object({
  stage: z.enum(["started", "researching", "drafting", "reviewing", "finalizing"]),
  message: z
    .string()
    .trim()
    .min(1)
    .max(280)
    .refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), "Use plain text."),
  percent: z.number().int().min(0).max(100).optional(),
});

export function registerProgressRoutes(
  router: Router,
  assertRuntimeAgentScope: (
    request: Parameters<Parameters<typeof asyncRoute>[0]>[0],
    jobId: string,
  ) => Promise<void>,
) {
  // The agent owner (or its scoped runtime) reports milestones while a funded job is running.
  router.post(
    "/:id/progress",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const input = progressInput.parse(request.body);
      await assertRuntimeAgentScope(request, jobId);
      if (request.runtimeAuth && !request.runtimeAuth.scopes.includes("deliverables:write"))
        throw new ApiError(
          403,
          "runtime_scope_denied",
          "This runtime token cannot report progress.",
        );
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const job = await client.query<{ status: string; provider_id: string }>(
          `SELECT j.status, a.owner_id AS provider_id FROM jobs j JOIN agents a ON a.id = j.agent_id
           WHERE j.id = $1 FOR UPDATE OF j`,
          [jobId],
        );
        if (!job.rowCount || job.rows[0].provider_id !== request.auth!.userId)
          throw new ApiError(404, "job_not_found", "This job is not available to this account.");
        if (job.rows[0].status !== "funded")
          throw new ApiError(
            409,
            "job_not_in_progress",
            "Progress can be reported only while a funded job is being worked on.",
          );
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM job_progress WHERE job_id = $1",
          [jobId],
        );
        if (count.rows[0].count >= MAX_PROGRESS_UPDATES)
          throw new ApiError(
            409,
            "progress_limit",
            `A job can carry at most ${MAX_PROGRESS_UPDATES} progress updates.`,
          );
        const created = await client.query(
          `INSERT INTO job_progress (job_id, stage, message, percent, actor_id)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, stage, message, percent, created_at`,
          [jobId, input.stage, input.message, input.percent ?? null, request.auth!.userId],
        );
        await client.query("COMMIT");
        response.status(201).json({ data: created.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  router.get(
    "/:id/progress",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const job = await db.query(
        `SELECT 1 FROM jobs j JOIN agents a ON a.id = j.agent_id
         WHERE j.id = $1 AND (j.client_id = $2 OR a.owner_id = $2 OR j.evaluator_id = $2)`,
        [jobId, userId],
      );
      if (!job.rowCount)
        throw new ApiError(404, "job_not_found", "This job is not available to this account.");
      const progress = await db.query(
        `SELECT id, stage, message, percent, created_at FROM job_progress
         WHERE job_id = $1 ORDER BY created_at, id`,
        [jobId],
      );
      response.json({ data: progress.rows });
    }),
  );
}
