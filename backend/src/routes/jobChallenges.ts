import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { challengeBond, openChallenge, resolveChallenge } from "../challenges.js";
import { decryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

type DisputeRow = {
  id: string;
  job_id: string;
  challenger_id: string;
  reason_ciphertext: string;
  challenge_bond_usdg: string;
  asset: string;
  decided_outcome: string;
  status: string;
  resolution: string | null;
  resolution_rationale_ciphertext: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

const presentDispute = (row: DisputeRow) => ({
  id: row.id,
  jobId: row.job_id,
  challengerId: row.challenger_id,
  reason: decryptPayload(row.reason_ciphertext, payloadContext(row.job_id, "challenge")),
  bond: row.challenge_bond_usdg,
  asset: row.asset,
  decidedOutcome: row.decided_outcome,
  status: row.status,
  resolution: row.resolution,
  rationale: row.resolution_rationale_ciphertext
    ? decryptPayload(
        row.resolution_rationale_ciphertext,
        payloadContext(row.job_id, "challenge-resolution"),
      )
    : null,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const disputeColumns = `d.id, d.job_id, d.challenger_id, d.reason_ciphertext,
  trim_scale(d.challenge_bond_usdg)::text AS challenge_bond_usdg, d.asset, d.decided_outcome,
  d.status, d.resolution, d.resolution_rationale_ciphertext, d.created_at, d.resolved_at`;

export function registerChallengeRoutes(router: Router) {
  router.get(
    "/:id/challenge",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const job = await db.query<{
        status: string;
        payout_due_at: Date | null;
        payout_released_at: Date | null;
        budget_amount: string;
        settlement_asset: "usdg" | "liege";
      }>(
        `SELECT j.status, j.payout_due_at, j.payout_released_at, j.budget_amount, j.settlement_asset
         FROM jobs j JOIN agents a ON a.id = j.agent_id
         WHERE j.id = $1 AND $2 IN (j.client_id, a.owner_id, j.evaluator_id)`,
        [jobId, request.auth!.userId],
      );
      if (!job.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
      const row = job.rows[0];
      const dispute = await db.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d WHERE d.job_id = $1`,
        [jobId],
      );
      const open =
        Boolean(row.payout_due_at) &&
        !row.payout_released_at &&
        ["completed", "rejected"].includes(row.status) &&
        new Date(row.payout_due_at!) > new Date();
      response.json({
        data: {
          windowOpen: open,
          payoutDueAt: row.payout_due_at,
          payoutReleasedAt: row.payout_released_at,
          bond: String(challengeBond(row)),
          asset: row.settlement_asset,
          dispute: dispute.rows[0] ? presentDispute(dispute.rows[0]) : null,
        },
      });
    }),
  );

  router.post(
    "/:id/challenge",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const { reason } = z
        .object({ reason: z.string().trim().min(10).max(4_000) })
        .parse(request.body);
      const disputeId = await openChallenge({
        jobId,
        userId: request.auth!.userId,
        reason,
        requestId: request.requestId,
      });
      const dispute = await db.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d WHERE d.id = $1`,
        [disputeId],
      );
      response.status(201).json({ data: presentDispute(dispute.rows[0]) });
    }),
  );
}

export function registerDisputeAdminRoutes(router: Router) {
  router.get(
    "/disputes",
    asyncRoute(async (request, response) => {
      const { status } = z
        .object({ status: z.enum(["open", "resolved"]).default("open") })
        .parse(request.query);
      const result = await db.query<DisputeRow & { title: string }>(
        `SELECT ${disputeColumns}, j.title FROM disputes d JOIN jobs j ON j.id = d.job_id
         WHERE ($1 = 'open') = (d.status = 'open') ORDER BY d.created_at LIMIT 100`,
        [status],
      );
      response.json({
        data: result.rows.map((row) => ({ ...presentDispute(row), jobTitle: row.title })),
      });
    }),
  );

  router.post(
    "/disputes/:id/resolve",
    asyncRoute(async (request, response) => {
      const disputeId = z.string().uuid().parse(request.params.id);
      const input = z
        .object({
          resolution: z.enum(["upheld", "denied"]),
          rationale: z.string().trim().min(10).max(4_000),
        })
        .parse(request.body);
      response.json({
        data: await resolveChallenge({
          disputeId,
          resolverId: request.auth!.userId,
          resolution: input.resolution,
          rationale: input.rationale,
          requestId: request.requestId,
        }),
      });
    }),
  );
}
