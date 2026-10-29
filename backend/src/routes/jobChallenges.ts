import type { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import {
  appealBond,
  appealPanelDecision,
  challengeBond,
  openChallenge,
  resolveChallenge,
} from "../challenges.js";
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
  mode: "arbitrator" | "panel";
  panel_deadline_at: Date | null;
  slashed_amount: string | null;
  panel_resolution: string | null;
  appeal_deadline_at: Date | null;
  appellant_id: string | null;
  appeal_reason_ciphertext: string | null;
  appeal_bond: string | null;
  appealed_at: Date | null;
  appeal_outcome: string | null;
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
  // Who decides: a panel of independent evaluators until its deadline, else a Liege arbitrator.
  decidedBy: row.mode,
  // Stake taken from an overturned evaluator and paid to the challenger.
  slashedAmount: row.slashed_amount,
  panelDeadlineAt: row.panel_deadline_at,
  // A panel's majority decision, which settles at appealDeadlineAt unless the losing side appeals.
  panelResolution: row.panel_resolution,
  appealDeadlineAt: row.appeal_deadline_at,
  appealBond: row.panel_resolution
    ? String(appealBond(row.challenge_bond_usdg, row.asset as "usdg" | "liege"))
    : null,
  appeal: row.appellant_id
    ? {
        appellantId: row.appellant_id,
        reason: decryptPayload(row.appeal_reason_ciphertext!, payloadContext(row.job_id, "appeal")),
        bond: row.appeal_bond,
        appealedAt: row.appealed_at,
        // Set once the arbitrator rules: overturned returns the bond, affirmed forfeits it.
        outcome: row.appeal_outcome,
      }
    : null,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const disputeColumns = `d.id, d.job_id, d.challenger_id, d.reason_ciphertext,
  trim_scale(d.challenge_bond_usdg)::text AS challenge_bond_usdg, d.asset, d.decided_outcome,
  d.status, d.resolution, d.resolution_rationale_ciphertext, d.mode, d.panel_deadline_at,
  trim_scale(d.slashed_amount)::text AS slashed_amount, d.panel_resolution, d.appeal_deadline_at,
  d.appellant_id, d.appeal_reason_ciphertext, trim_scale(d.appeal_bond)::text AS appeal_bond,
  d.appealed_at, d.appeal_outcome, d.created_at, d.resolved_at`;

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
        client_id: string;
        provider_id: string;
      }>(
        `SELECT j.status, j.payout_due_at, j.payout_released_at, j.budget_amount, j.settlement_asset,
           j.client_id, a.owner_id AS provider_id
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
      const found = dispute.rows[0];
      // The side the panel ruled against may appeal while the window is open.
      const panelLoser = found?.panel_resolution
        ? (found.panel_resolution === "upheld") === (found.challenger_id === row.client_id)
          ? row.provider_id
          : row.client_id
        : null;
      const canAppeal =
        found?.status === "open" &&
        !found.appellant_id &&
        panelLoser === request.auth!.userId &&
        new Date(found.appeal_deadline_at!) > new Date();
      response.json({
        data: {
          windowOpen: open,
          payoutDueAt: row.payout_due_at,
          payoutReleasedAt: row.payout_released_at,
          bond: String(challengeBond(row)),
          asset: row.settlement_asset,
          dispute: found ? presentDispute(found) : null,
          canAppeal,
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

  router.post(
    "/:id/appeal",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const { reason } = z
        .object({ reason: z.string().trim().min(10).max(4_000) })
        .parse(request.body);
      const disputeId = await appealPanelDecision({
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
