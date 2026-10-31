import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

/**
 * Watch links: a client shares a public, read-only view of one job while the agent works on it.
 * The view carries the title, the agent, status, timestamps, and the agent's progress updates. It
 * never carries the brief, the deliverable, attachments, or amounts.
 */

const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{24}$/);

async function clientJob(jobId: string, userId: string) {
  const job = await db.query("SELECT 1 FROM jobs WHERE id = $1 AND client_id = $2", [
    jobId,
    userId,
  ]);
  if (!job.rowCount)
    throw new ApiError(404, "job_not_found", "Only the job's client can share it.");
}

export function registerWatchLinkRoutes(router: Router) {
  router.get(
    "/:id/watch-link",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      await clientJob(jobId, request.auth!.userId);
      const link = await db.query<{ token: string; created_at: Date }>(
        "SELECT token, created_at FROM job_watch_links WHERE job_id = $1",
        [jobId],
      );
      const row = link.rows[0];
      response.json({ data: row ? { token: row.token, createdAt: row.created_at } : null });
    }),
  );

  // Creates the job's watch link, or returns the one it already has.
  router.post(
    "/:id/watch-link",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot share jobs.");
      const jobId = z.string().uuid().parse(request.params.id);
      await clientJob(jobId, request.auth!.userId);
      await db.query(
        `INSERT INTO job_watch_links (job_id, token, created_by) VALUES ($1,$2,$3)
         ON CONFLICT (job_id) DO NOTHING`,
        [jobId, randomBytes(18).toString("base64url"), request.auth!.userId],
      );
      const link = await db.query<{ token: string; created_at: Date }>(
        "SELECT token, created_at FROM job_watch_links WHERE job_id = $1",
        [jobId],
      );
      await audit(db, {
        actorId: request.auth!.userId,
        action: "job.watch_link_shared",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
      });
      response
        .status(201)
        .json({ data: { token: link.rows[0].token, createdAt: link.rows[0].created_at } });
    }),
  );

  // Revokes the link; anyone holding it sees a 404 from then on.
  router.delete(
    "/:id/watch-link",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      await clientJob(jobId, request.auth!.userId);
      await db.query("DELETE FROM job_watch_links WHERE job_id = $1", [jobId]);
      await audit(db, {
        actorId: request.auth!.userId,
        action: "job.watch_link_revoked",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
      });
      response.status(204).end();
    }),
  );
}

/** The public side: anyone with the token sees the job's live progress. */
export const watchRouter = Router();

watchRouter.get(
  "/:token",
  asyncRoute(async (request, response) => {
    const token = tokenParam.safeParse(request.params.token);
    if (!token.success) throw new ApiError(404, "watch_link_not_found", "This link is not active.");
    const found = await db.query<{
      id: string;
      public_id: string;
      title: string;
      status: string;
      agent_name: string;
      agent_slug: string;
      created_at: Date;
      funded_at: Date | null;
      promised_by: Date | null;
      submitted_at: Date | null;
      settled_at: Date | null;
    }>(
      `SELECT j.id, j.public_id, j.title, j.status::text AS status, a.name AS agent_name,
         a.slug AS agent_slug, j.created_at, j.funded_at,
         j.funded_at + j.promised_minutes * interval '1 minute' AS promised_by,
         j.submitted_at, j.settled_at
       FROM job_watch_links w JOIN jobs j ON j.id = w.job_id JOIN agents a ON a.id = j.agent_id
       WHERE w.token = $1`,
      [token.data],
    );
    const job = found.rows[0];
    if (!job) throw new ApiError(404, "watch_link_not_found", "This link is not active.");
    const progress = await db.query<{
      stage: string;
      message: string;
      percent: number | null;
      created_at: Date;
    }>(
      `SELECT stage, message, percent, created_at FROM job_progress
       WHERE job_id = $1 ORDER BY created_at, id`,
      [job.id],
    );
    response.set("cache-control", "no-store").json({
      data: {
        publicId: job.public_id,
        title: job.title,
        status: job.status,
        agent: { name: job.agent_name, slug: job.agent_slug },
        createdAt: job.created_at,
        fundedAt: job.funded_at,
        promisedBy: job.promised_by,
        submittedAt: job.submitted_at,
        settledAt: job.settled_at,
        progress: progress.rows.map((row) => ({
          stage: row.stage,
          message: row.message,
          percent: row.percent,
          at: row.created_at,
        })),
      },
    });
  }),
);
