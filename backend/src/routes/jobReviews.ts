import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

// A client can change their review for this long after writing it.
const EDIT_DAYS = 14;
const text = z
  .string()
  .transform((value) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim())
  .pipe(z.string().max(1000));
const reviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  comment: text.optional(),
});

type ReviewedJob = {
  id: string;
  title: string;
  status: string;
  client_id: string;
  agent_id: string;
  agent_name: string;
  provider_id: string;
  funded_at: Date | null;
};

async function lockJob(client: { query: typeof db.query }, jobId: string) {
  const found = await client.query<ReviewedJob>(
    `SELECT j.id, j.title, j.status, j.client_id, j.agent_id, a.name AS agent_name,
       a.owner_id AS provider_id, j.funded_at
     FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
    [jobId],
  );
  return found.rows[0];
}

/** A job can be reviewed once it has an outcome: accepted, rejected, or funded but never delivered. */
const reviewable = (job: ReviewedJob) =>
  job.status === "completed" ||
  job.status === "rejected" ||
  (job.status === "expired" && job.funded_at !== null);

/**
 * Reviews: the client of a finished job rates it 1-5 with an optional comment (editable for 14
 * days), and the agent's owner may answer once. Reviews sit beside the recorded track record;
 * the reputation score is computed from outcomes only and never reads them.
 */
export function registerReviewRoutes(router: Router) {
  router.post(
    "/:id/review",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const input = reviewInput.parse(request.body);
      const comment = input.comment || null;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const job = await lockJob(client, jobId);
        if (!job || job.client_id !== request.auth!.userId)
          throw new ApiError(404, "job_not_found", "This job does not exist.");
        if (!reviewable(job))
          throw new ApiError(
            409,
            "review_not_available",
            "A job can be reviewed once it is accepted, rejected, or expired after funding.",
          );
        const existing = await client.query<{ editable: boolean }>(
          `SELECT created_at > now() - make_interval(days => $2) AS editable
           FROM job_reviews WHERE job_id = $1`,
          [job.id, EDIT_DAYS],
        );
        if (existing.rowCount && !existing.rows[0].editable)
          throw new ApiError(
            409,
            "review_locked",
            `A review can be changed for ${EDIT_DAYS} days after it is written.`,
          );
        const saved = await client.query(
          `INSERT INTO job_reviews (job_id, agent_id, client_id, rating, comment)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (job_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment,
             updated_at = now()
           RETURNING job_id, rating, comment, reply, replied_at, created_at, updated_at`,
          [job.id, job.agent_id, job.client_id, input.rating, comment],
        );
        if (!existing.rowCount) {
          // Tell the owner once, when the review first appears.
          const event = await client.query<{ id: string; created_at: Date }>(
            "INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1,$2,'job.reviewed',$3) RETURNING id, created_at",
            [job.id, job.client_id, JSON.stringify({ rating: input.rating })],
          );
          await client.query(
            `INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
             VALUES ($1,$2,$3,'job.reviewed',$4,$5,$6) ON CONFLICT (user_id, event_id) DO NOTHING`,
            [
              job.provider_id,
              job.id,
              event.rows[0].id,
              `New ${input.rating}-star review for ${job.agent_name}`,
              comment
                ? `"${comment.length > 160 ? `${comment.slice(0, 157)}…` : comment}" You can reply on the job page.`
                : `The client rated "${job.title}". You can reply on the job page.`,
              event.rows[0].created_at,
            ],
          );
        }
        await audit(client, {
          actorId: job.client_id,
          action: existing.rowCount ? "job.review_updated" : "job.reviewed",
          targetType: "job",
          targetId: job.id,
          requestId: request.requestId,
          metadata: { rating: input.rating, comment: Boolean(comment) },
        });
        await client.query("COMMIT");
        response.status(existing.rowCount ? 200 : 201).json({ data: saved.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  router.post(
    "/:id/review/reply",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const { reply } = z.object({ reply: text.pipe(z.string().min(1)) }).parse(request.body);
      const updated = await db.query(
        `UPDATE job_reviews r SET reply = $3, replied_at = now(), updated_at = now()
         FROM agents a WHERE r.job_id = $1 AND a.id = r.agent_id AND a.owner_id = $2
           AND r.reply IS NULL
         RETURNING r.job_id, r.rating, r.comment, r.reply, r.replied_at, r.created_at, r.updated_at`,
        [jobId, request.auth!.userId, reply],
      );
      if (!updated.rowCount) {
        const found = await db.query(
          `SELECT r.reply FROM job_reviews r JOIN agents a ON a.id = r.agent_id
           WHERE r.job_id = $1 AND a.owner_id = $2`,
          [jobId, request.auth!.userId],
        );
        if (!found.rowCount)
          throw new ApiError(404, "review_not_found", "This job has no review to answer.");
        throw new ApiError(409, "review_already_answered", "This review already has a reply.");
      }
      await audit(db, {
        actorId: request.auth!.userId,
        action: "job.review_replied",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
      });
      response.json({ data: updated.rows[0] });
    }),
  );
}

/** Rating summary and newest reviews for a public agent profile. */
export async function agentReviews(agentId: string, limit: number, before?: string) {
  const [summary, items] = await Promise.all([
    db.query<{ count: number; average: string | null; distribution: Record<string, number> }>(
      `SELECT count(*)::int AS count, round(avg(rating), 1)::text AS average,
         json_build_object('1', count(*) FILTER (WHERE rating = 1), '2', count(*) FILTER (WHERE rating = 2),
           '3', count(*) FILTER (WHERE rating = 3), '4', count(*) FILTER (WHERE rating = 4),
           '5', count(*) FILTER (WHERE rating = 5)) AS distribution
       FROM job_reviews WHERE agent_id = $1`,
      [agentId],
    ),
    db.query(
      `SELECT r.job_id, r.rating, r.comment, r.reply, r.replied_at, r.created_at, j.status AS job_status
       FROM job_reviews r JOIN jobs j ON j.id = r.job_id
       WHERE r.agent_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
       ORDER BY r.created_at DESC LIMIT $3`,
      [agentId, before ?? null, limit + 1],
    ),
  ]);
  const page = items.rows.slice(0, limit);
  return {
    count: summary.rows[0].count,
    average: summary.rows[0].average === null ? null : Number(summary.rows[0].average),
    distribution: summary.rows[0].distribution,
    // Reviewers stay anonymous; job_id is kept so a review can be traced to its receipt.
    items: page,
    nextCursor: items.rows.length > limit ? new Date(page.at(-1)!.created_at).toISOString() : null,
  };
}
