import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { decryptPayload, encryptPayload, payloadContext, payloadDigest } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { enqueueWebhookEvent } from "../webhooks.js";

export const MAX_REVISIONS = 1;
const HOUR = 3_600_000;

/**
 * Time the provider gets for the revision: as long as the original work window (funding to
 * deadline), at least an hour and at most a day. The deadline only ever moves later.
 */
export function revisionDeadline(input: { now: Date; deadlineAt: Date; fundedAt: Date | null }) {
  const original = input.fundedAt
    ? input.deadlineAt.getTime() - input.fundedAt.getTime()
    : 24 * HOUR;
  const window = Math.min(24 * HOUR, Math.max(HOUR, original));
  return new Date(Math.max(input.deadlineAt.getTime(), input.now.getTime() + window));
}

const revisionInput = z.object({ feedback: z.string().trim().min(1).max(10_000) });

export function registerRevisionRoutes(router: Router) {
  // Instead of rejecting a submission, whoever settles the job sends it back once with
  // feedback. Escrow is untouched; the job is funded again and the provider is notified.
  router.post(
    "/:id/revision",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const { feedback } = revisionInput.parse(request.body);
      const userId = request.auth!.userId;
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot request revisions.");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{
          id: string;
          status: string;
          client_id: string;
          evaluator_id: string | null;
          provider_id: string;
          deadline_at: Date;
          expires_at: Date;
          funded_at: Date | null;
          revision_count: number;
          delegated: boolean;
        }>(
          `SELECT j.id, j.status, j.client_id, j.evaluator_id, a.owner_id AS provider_id, j.deadline_at,
             j.expires_at, j.funded_at, j.revision_count,
             EXISTS (SELECT 1 FROM legions l WHERE l.job_id = j.id) AS delegated
           FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
          [jobId],
        );
        const job = found.rows[0];
        const settler = job ? (job.evaluator_id ?? job.client_id) : null;
        if (!job || ![job.client_id, job.evaluator_id, job.provider_id].includes(userId))
          throw new ApiError(404, "job_not_found", "This job is not available to this account.");
        if (settler !== userId)
          throw new ApiError(
            403,
            job.evaluator_id ? "not_evaluator" : "not_client",
            job.evaluator_id
              ? "Only the assigned evaluator can request a revision."
              : "Only the job client can request a revision.",
          );
        if (job.status !== "submitted")
          throw new ApiError(
            409,
            "invalid_job_transition",
            `A ${job.status} job cannot be sent back for revision.`,
          );
        if (job.revision_count >= MAX_REVISIONS)
          throw new ApiError(
            409,
            "revision_limit",
            "This job has already been revised once. Accept or reject it.",
          );
        if (job.delegated)
          throw new ApiError(
            409,
            "revision_unavailable",
            "Delegated jobs cannot be sent back for revision.",
          );
        const now = new Date();
        const deadline = revisionDeadline({
          now,
          deadlineAt: job.deadline_at,
          fundedAt: job.funded_at,
        });
        // Leave time to review the revision before expiry refunds the escrow.
        if (deadline.getTime() > job.expires_at.getTime() - HOUR)
          throw new ApiError(
            409,
            "revision_too_late",
            "This job expires too soon for a revision. Accept or reject it.",
          );
        const submission = await client.query<{
          deliverable_ciphertext: string | null;
          deliverable_hash: string;
          evidence: unknown;
          created_at: Date;
        }>(
          "DELETE FROM submissions WHERE job_id = $1 RETURNING deliverable_ciphertext, deliverable_hash, evidence, created_at",
          [jobId],
        );
        if (!submission.rowCount)
          throw new ApiError(409, "submission_missing", "This job has no submission to revise.");
        const previous = submission.rows[0];
        await client.query(
          `INSERT INTO job_revisions (job_id, requested_by, feedback_ciphertext, feedback_hash,
             previous_deliverable_ciphertext, previous_deliverable_hash, previous_evidence,
             previous_submitted_at, previous_deadline_at, deadline_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            jobId,
            userId,
            encryptPayload(feedback, payloadContext(jobId, "revision")),
            payloadDigest(feedback),
            previous.deliverable_ciphertext,
            previous.deliverable_hash,
            JSON.stringify(previous.evidence ?? []),
            previous.created_at,
            job.deadline_at,
            deadline,
          ],
        );
        const updated = await client.query(
          `UPDATE jobs SET status = 'funded', submitted_at = NULL, deadline_at = $2,
             revision_count = revision_count + 1, updated_at = now()
           WHERE id = $1 RETURNING id, public_id, status, deadline_at, expires_at, revision_count`,
          [jobId, deadline],
        );
        await client.query(
          "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)",
          [jobId, userId, "job.revision_requested"],
        );
        await enqueueWebhookEvent(client, {
          jobId,
          eventType: "job.revision_requested",
          actorId: userId,
          data: { revision: job.revision_count + 1, deadlineAt: deadline.toISOString() },
        });
        await audit(client, {
          actorId: userId,
          action: "job.revision_requested",
          targetType: "job",
          targetId: jobId,
          requestId: request.requestId,
          metadata: { previousDeadline: job.deadline_at, deadline },
        });
        await client.query("COMMIT");
        response.json({ data: updated.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  // The provider (or its runtime with briefs:read) and the settler read the revision: the
  // feedback and the first deliverable it refers to.
  router.get(
    "/:id/revision",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const found = await db.query<{
        agent_id: string;
        client_id: string;
        evaluator_id: string | null;
        provider_id: string;
        expires_at: Date;
        feedback_ciphertext: string | null;
        previous_deliverable_ciphertext: string | null;
        previous_evidence: unknown;
        previous_submitted_at: Date | null;
        deadline_at: Date | null;
        created_at: Date | null;
      }>(
        `SELECT j.agent_id, j.client_id, j.evaluator_id, a.owner_id AS provider_id, j.expires_at,
           r.feedback_ciphertext, r.previous_deliverable_ciphertext, r.previous_evidence,
           r.previous_submitted_at, r.deadline_at, r.created_at
         FROM jobs j JOIN agents a ON a.id = j.agent_id LEFT JOIN job_revisions r ON r.job_id = j.id
         WHERE j.id = $1`,
        [jobId],
      );
      const row = found.rows[0];
      if (!row || ![row.client_id, row.evaluator_id, row.provider_id].includes(userId))
        throw new ApiError(404, "job_not_found", "This job is not available to this account.");
      if (
        request.runtimeAuth &&
        (!request.runtimeAuth.agentIds.includes(row.agent_id) ||
          !request.runtimeAuth.scopes.includes("briefs:read"))
      )
        throw new ApiError(
          403,
          "runtime_scope_denied",
          "This runtime token cannot read this revision.",
        );
      if (row.expires_at <= new Date())
        throw new ApiError(
          410,
          "payload_expired",
          "Private payload access for this job has expired.",
        );
      if (!row.feedback_ciphertext)
        throw new ApiError(404, "revision_not_found", "This job has no revision request.");
      await audit(db, {
        actorId: userId,
        action: "job.revision_accessed",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
      });
      response.json({
        data: {
          feedback: decryptPayload(row.feedback_ciphertext, payloadContext(jobId, "revision")),
          previousDeliverable: row.previous_deliverable_ciphertext
            ? decryptPayload(
                row.previous_deliverable_ciphertext,
                payloadContext(jobId, "deliverable"),
              )
            : null,
          previousEvidence: row.previous_evidence ?? [],
          previousSubmittedAt: row.previous_submitted_at,
          deadlineAt: row.deadline_at,
          requestedAt: row.created_at,
        },
      });
    }),
  );
}
