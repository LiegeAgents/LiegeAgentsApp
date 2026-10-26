import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { decryptPayload, encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { gradeDelivery, type SecondOpinion } from "../secondOpinion.js";

type JobRow = {
  id: string;
  status: string;
  client_id: string;
  evaluator_id: string | null;
  provider_id: string;
  brief_ciphertext: string;
  acceptance_criteria: string[];
  submission_id: string | null;
  deliverable_ciphertext: string | null;
  evidence: string[] | null;
};

const GRADABLE = ["submitted", "completed", "rejected", "challenged"];

async function loadJob(jobId: string, userId: string) {
  const result = await db.query<JobRow>(
    `SELECT j.id, j.status, j.client_id, j.evaluator_id, a.owner_id AS provider_id,
       j.brief_ciphertext, j.acceptance_criteria, s.id AS submission_id,
       s.deliverable_ciphertext, s.evidence
     FROM jobs j JOIN agents a ON a.id = j.agent_id
     LEFT JOIN LATERAL (SELECT * FROM submissions WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1) s ON true
     WHERE j.id = $1 AND $2 IN (j.client_id, j.evaluator_id, a.owner_id)`,
    [jobId, userId],
  );
  const job = result.rows[0];
  if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
  return job;
}

async function stored(submissionId: string | null) {
  if (!submissionId) return null;
  const result = await db.query<{
    id: string;
    score: number;
    model: string;
    result_ciphertext: string;
    created_at: Date;
  }>(
    "SELECT id, score, model, result_ciphertext, created_at FROM job_second_opinions WHERE submission_id = $1",
    [submissionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const opinion = JSON.parse(
    decryptPayload(row.result_ciphertext, payloadContext(row.id, "second-opinion")),
  ) as SecondOpinion;
  return { ...opinion, score: row.score, model: row.model, createdAt: row.created_at };
}

export function registerSecondOpinionRoutes(router: Router) {
  router.get(
    "/:id/second-opinion",
    requireAuth,
    asyncRoute(async (request, response) => {
      const job = await loadJob(z.string().uuid().parse(request.params.id), request.auth!.userId);
      response.json({ data: await stored(job.submission_id) });
    }),
  );

  router.post(
    "/:id/second-opinion",
    requireAuth,
    asyncRoute(async (request, response) => {
      const job = await loadJob(z.string().uuid().parse(request.params.id), request.auth!.userId);
      const decider = job.evaluator_id ?? job.client_id;
      if (request.auth!.userId !== decider && request.auth!.userId !== job.client_id)
        throw new ApiError(
          403,
          "not_decider",
          "Only the client or the evaluator can ask for a second opinion.",
        );
      if (!job.submission_id || !job.deliverable_ciphertext || !GRADABLE.includes(job.status))
        throw new ApiError(409, "nothing_to_grade", "There is no delivery to grade yet.");
      // One grade per delivery: asking again returns it instead of grading twice.
      const existing = await stored(job.submission_id);
      if (existing) return response.json({ data: existing });
      const opinion = await gradeDelivery({
        brief: decryptPayload(job.brief_ciphertext, payloadContext(job.id, "brief")),
        criteria: job.acceptance_criteria,
        deliverable: decryptPayload(
          job.deliverable_ciphertext,
          payloadContext(job.id, "deliverable"),
        ),
        evidence: job.evidence ?? [],
      });
      const id = crypto.randomUUID();
      const inserted = await db.query(
        `INSERT INTO job_second_opinions (id, job_id, submission_id, requested_by, model, score, result_ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (submission_id) DO NOTHING`,
        [
          id,
          job.id,
          job.submission_id,
          request.auth!.userId,
          env.GROQ_MODEL,
          opinion.score,
          encryptPayload(JSON.stringify(opinion), payloadContext(id, "second-opinion")),
        ],
      );
      // The brief and delivery left Liege for the grading model, at this person's request.
      await audit(db, {
        actorId: request.auth!.userId,
        action: "job.second_opinion_requested",
        targetType: "job",
        targetId: job.id,
        requestId: request.requestId,
        metadata: { model: env.GROQ_MODEL, score: opinion.score },
      });
      response
        .status(inserted.rowCount ? 201 : 200)
        .json({ data: await stored(job.submission_id) });
    }),
  );
}
