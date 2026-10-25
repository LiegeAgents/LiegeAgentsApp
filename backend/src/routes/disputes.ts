import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { castPanelVote } from "../challenges.js";
import { decryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

/**
 * The panelist's side of a dispute: what was decided, why it was challenged, the brief and the
 * delivery, and a vote. Panelists never see who else is on the panel or how they voted until the
 * dispute is resolved, and then only the tally.
 */
export const disputesRouter = Router();

type PanelRow = {
  id: string;
  job_id: string;
  title: string;
  decided_outcome: string;
  status: string;
  resolution: string | null;
  panel_deadline_at: Date;
  created_at: Date;
  my_decision: string | null;
  upheld: number;
  denied: number;
  members: number;
};

const panelColumns = `d.id, d.job_id, j.title, d.decided_outcome, d.status, d.resolution,
  d.panel_deadline_at, d.created_at, m.decision AS my_decision,
  (SELECT count(*) FILTER (WHERE x.decision = 'upheld') FROM dispute_panel_members x WHERE x.dispute_id = d.id)::int AS upheld,
  (SELECT count(*) FILTER (WHERE x.decision = 'denied') FROM dispute_panel_members x WHERE x.dispute_id = d.id)::int AS denied,
  (SELECT count(*) FROM dispute_panel_members x WHERE x.dispute_id = d.id)::int AS members`;

const summary = (row: PanelRow) => ({
  id: row.id,
  jobId: row.job_id,
  jobTitle: row.title,
  decidedOutcome: row.decided_outcome,
  status: row.status,
  resolution: row.resolution,
  panelDeadlineAt: row.panel_deadline_at,
  myVote: row.my_decision,
  // The tally is shown once the dispute is resolved, so no one votes with the crowd.
  tally: row.status === "open" ? null : { upheld: row.upheld, denied: row.denied, of: row.members },
  createdAt: row.created_at,
});

disputesRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query<PanelRow>(
      `SELECT ${panelColumns} FROM dispute_panel_members m
       JOIN disputes d ON d.id = m.dispute_id JOIN jobs j ON j.id = d.job_id
       WHERE m.evaluator_id = $1
       ORDER BY (d.status = 'open' AND m.decision IS NULL) DESC, d.created_at DESC LIMIT 100`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows.map(summary) });
  }),
);

disputesRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query<
      PanelRow & {
        reason_ciphertext: string;
        brief_ciphertext: string;
        acceptance_criteria: string[];
        budget_amount: string;
        settlement_asset: string;
        deliverable_ciphertext: string | null;
      }
    >(
      `SELECT ${panelColumns}, d.reason_ciphertext, j.brief_ciphertext, j.acceptance_criteria,
         trim_scale(j.budget_amount)::text AS budget_amount, j.settlement_asset,
         (SELECT s.deliverable_ciphertext FROM submissions s WHERE s.job_id = j.id
          ORDER BY s.created_at DESC LIMIT 1) AS deliverable_ciphertext
       FROM dispute_panel_members m
       JOIN disputes d ON d.id = m.dispute_id JOIN jobs j ON j.id = d.job_id
       WHERE d.id = $1 AND m.evaluator_id = $2`,
      [id, request.auth!.userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "dispute_not_found", "Dispute not found.");
    response.json({
      data: {
        ...summary(row),
        reason: decryptPayload(row.reason_ciphertext, payloadContext(row.job_id, "challenge")),
        brief: decryptPayload(row.brief_ciphertext, payloadContext(row.job_id, "brief")),
        acceptanceCriteria: row.acceptance_criteria,
        budget: row.budget_amount,
        asset: row.settlement_asset,
        deliverable: row.deliverable_ciphertext
          ? decryptPayload(row.deliverable_ciphertext, payloadContext(row.job_id, "deliverable"))
          : null,
      },
    });
  }),
);

disputesRouter.post(
  "/:id/vote",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const input = z
      .object({
        decision: z.enum(["upheld", "denied"]),
        rationale: z.string().trim().min(10).max(4_000),
      })
      .parse(request.body);
    response.json({
      data: await castPanelVote({
        disputeId: id,
        evaluatorId: request.auth!.userId,
        decision: input.decision,
        rationale: input.rationale,
        requestId: request.requestId,
      }),
    });
  }),
);
