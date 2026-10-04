import { Router } from "express";
import { verifyMessage } from "viem";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { encryptPayload, payloadContext, payloadDigest } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { evidenceUrl } from "../evidence.js";
import { decisionMessage, type EvaluationCriterion } from "../evaluation.js";
import { minimumEvaluatorStake } from "../capacity.js";

const criterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  prompt: z.string().min(3).max(500),
  weight: z.number().positive().max(100),
  maxScore: z.number().positive().max(100),
});
const createInput = z
  .object({
    agentId: z.string().uuid().optional(),
    jobId: z.string().uuid().optional(),
    evaluatorId: z.string().uuid(),
    title: z.string().min(3).max(160),
    instructions: z.string().min(10).max(5000),
    criteria: z.array(criterion).min(1).max(30),
    dueAt: z.coerce
      .date()
      .refine((date) => !Number.isNaN(date.getTime()), "dueAt must be a valid date."),
  })
  .refine((value) => value.agentId || value.jobId, "An agentId or jobId is required.");
const submitInput = z.object({
  outcome: z.enum(["accepted", "rejected"]),
  scores: z.record(z.number().min(0).max(100)),
  rationale: z.string().min(10).max(10_000),
  evidence: z.array(evidenceUrl).max(50).default([]),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
const decisionInput = submitInput.omit({ signature: true });

export const evaluationRouter = Router();

evaluationRouter.post(
  "/tasks",
  requireAuth,
  asyncRoute(async (request, response) => {
    const value = createInput.parse(request.body);
    if (value.dueAt <= new Date())
      throw new ApiError(400, "invalid_due_date", "The evaluation dueAt must be in the future.");
    const subject = value.jobId
      ? await db.query<{
          agent_id: string;
          client_id?: string;
          agent_owner_id?: string;
          settlement_asset: "usdg" | "liege";
        }>(
          "SELECT j.agent_id, j.client_id, a.owner_id AS agent_owner_id, j.settlement_asset FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE j.id=$1",
          [value.jobId],
        )
      : await db.query<{
          agent_id: string;
          client_id?: string;
          agent_owner_id?: string;
          settlement_asset: "usdg" | "liege";
        }>(
          "SELECT id AS agent_id, 'usdg'::text AS settlement_asset FROM agents WHERE id=$1 AND owner_id=$2",
          [value.agentId, request.auth!.userId],
        );
    if (!subject.rowCount)
      throw new ApiError(404, "subject_not_found", "The evaluation subject is unavailable.");
    if (
      value.jobId &&
      subject.rows[0].client_id !== request.auth!.userId &&
      subject.rows[0].agent_owner_id !== request.auth!.userId
    )
      throw new ApiError(
        403,
        "not_subject_owner",
        "Only the job client or agent owner can create this evaluation.",
      );
    if (value.jobId && value.agentId && subject.rows[0].agent_id !== value.agentId)
      throw new ApiError(400, "subject_mismatch", "The job does not belong to this agent.");
    const agentId = subject.rows[0].agent_id;
    const settlementAsset = subject.rows[0].settlement_asset;
    const evaluator = await db.query(
      `SELECT ep.user_id FROM evaluator_profiles ep
     WHERE ep.user_id=$1 AND ep.active AND COALESCE((SELECT sum(lp.amount) FROM ledger_accounts la JOIN ledger_postings lp ON lp.account_id=la.id WHERE la.user_id=ep.user_id AND la.kind='stake' AND la.asset=$2),0) >= $3`,
      [value.evaluatorId, settlementAsset, minimumEvaluatorStake(settlementAsset)],
    );
    if (!evaluator.rowCount)
      throw new ApiError(
        422,
        "evaluator_ineligible",
        "The assigned evaluator is not active or does not have enough stake.",
      );
    if (value.evaluatorId === request.auth!.userId)
      throw new ApiError(400, "self_evaluation", "The task creator cannot be its evaluator.");
    const created = await db.query<{ id: string }>(
      "INSERT INTO evaluation_tasks (creator_id,agent_id,job_id,evaluator_id,title,instructions,criteria,due_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [
        request.auth!.userId,
        agentId,
        value.jobId ?? null,
        value.evaluatorId,
        value.title,
        value.instructions,
        JSON.stringify(value.criteria),
        value.dueAt,
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "evaluation.task_created",
      targetType: "evaluation_task",
      targetId: created.rows[0].id,
      requestId: request.requestId,
      metadata: { evaluatorId: value.evaluatorId, agentId, jobId: value.jobId ?? null },
    });
    response
      .status(201)
      .json({ data: { id: created.rows[0].id, status: "assigned", ...value, agentId } });
  }),
);

evaluationRouter.get(
  "/tasks",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "SELECT id, creator_id, agent_id, job_id, evaluator_id, title, instructions, criteria, status, due_at, created_at, updated_at FROM evaluation_tasks WHERE creator_id=$1 OR evaluator_id=$1 ORDER BY created_at DESC LIMIT 100",
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

evaluationRouter.get(
  "/tasks/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "SELECT t.*, d.outcome, d.scores, d.evidence, d.decision_message, d.signature, d.created_at AS decided_at FROM evaluation_tasks t LEFT JOIN evaluation_decisions d ON d.task_id=t.id WHERE t.id=$1 AND (t.creator_id=$2 OR t.evaluator_id=$2)",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "evaluation_task_not_found", "This evaluation task is unavailable.");
    response.json({ data: result.rows[0] });
  }),
);

evaluationRouter.post(
  "/tasks/:id/decision-message",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const value = decisionInput.parse(request.body);
    const task = await db.query<{
      evaluator_id: string;
      criteria: EvaluationCriterion[];
      status: string;
      due_at: Date;
    }>("SELECT evaluator_id, criteria, status, due_at FROM evaluation_tasks WHERE id=$1", [id]);
    if (!task.rowCount)
      throw new ApiError(404, "evaluation_task_not_found", "This evaluation task is unavailable.");
    const row = task.rows[0];
    if (row.evaluator_id !== request.auth!.userId)
      throw new ApiError(
        403,
        "not_assigned_evaluator",
        "Only the assigned evaluator can sign this task.",
      );
    if (row.status !== "assigned" || row.due_at <= new Date())
      throw new ApiError(
        409,
        "evaluation_closed",
        "This evaluation task is no longer accepting decisions.",
      );
    const expected = new Set(row.criteria.map((item) => item.id));
    const actual = Object.keys(value.scores);
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key)))
      throw new ApiError(400, "invalid_scores", "Scores must include exactly every criterion.");
    for (const item of row.criteria)
      if (value.scores[item.id] > item.maxScore)
        throw new ApiError(400, "invalid_score", `Score for ${item.id} exceeds its maximum.`);
    const rationaleHash = payloadDigest(value.rationale);
    response.json({
      data: {
        message: decisionMessage({
          taskId: id,
          outcome: value.outcome,
          scores: value.scores,
          rationaleHash,
          evidence: value.evidence,
        }),
        rationaleHash,
      },
    });
  }),
);

evaluationRouter.post(
  "/tasks/:id/submit",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const value = submitInput.parse(request.body);
    const task = await db.query<{
      evaluator_id: string;
      wallet_address: string;
      criteria: EvaluationCriterion[];
      status: string;
      due_at: Date;
    }>(
      `SELECT t.evaluator_id, u.wallet_address, t.criteria, t.status, t.due_at FROM evaluation_tasks t JOIN users u ON u.id=t.evaluator_id WHERE t.id=$1`,
      [id],
    );
    if (!task.rowCount)
      throw new ApiError(404, "evaluation_task_not_found", "This evaluation task is unavailable.");
    const row = task.rows[0];
    if (row.evaluator_id !== request.auth!.userId)
      throw new ApiError(
        403,
        "not_assigned_evaluator",
        "Only the assigned evaluator can submit this task.",
      );
    if (row.status !== "assigned" || row.due_at <= new Date())
      throw new ApiError(
        409,
        "evaluation_closed",
        "This evaluation task is no longer accepting decisions.",
      );
    const criteria = row.criteria;
    const expected = new Set(criteria.map((item) => item.id));
    const actual = Object.keys(value.scores);
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key)))
      throw new ApiError(400, "invalid_scores", "Scores must include exactly every criterion.");
    for (const item of criteria)
      if (value.scores[item.id] > item.maxScore)
        throw new ApiError(400, "invalid_score", `Score for ${item.id} exceeds its maximum.`);
    const rationaleHash = payloadDigest(value.rationale);
    const message = decisionMessage({
      taskId: id,
      outcome: value.outcome,
      scores: value.scores,
      rationaleHash,
      evidence: value.evidence,
    });
    const valid = await verifyMessage({
      address: row.wallet_address as `0x${string}`,
      message,
      signature: value.signature as `0x${string}`,
    });
    if (!valid)
      throw new ApiError(
        401,
        "invalid_decision_signature",
        "The evaluator signature does not match the assigned wallet.",
      );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE evaluation_tasks SET status='submitted', updated_at=now() WHERE id=$1 AND status='assigned' RETURNING id",
        [id],
      );
      if (!updated.rowCount)
        throw new ApiError(409, "evaluation_closed", "This evaluation task was already submitted.");
      await client.query(
        "INSERT INTO evaluation_decisions (task_id,evaluator_id,outcome,scores,rationale_ciphertext,rationale_hash,evidence,decision_message,signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          request.auth!.userId,
          value.outcome,
          JSON.stringify(value.scores),
          encryptPayload(value.rationale, payloadContext(id, "rationale")),
          rationaleHash,
          JSON.stringify(value.evidence),
          message,
          value.signature,
        ],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "evaluation.decision_signed",
        targetType: "evaluation_task",
        targetId: id,
        requestId: request.requestId,
        metadata: { outcome: value.outcome, criteriaCount: criteria.length },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.status(201).json({
      data: {
        taskId: id,
        status: "submitted",
        outcome: value.outcome,
        scores: value.scores,
        evidence: value.evidence,
        decisionMessage: message,
        signature: value.signature,
      },
    });
  }),
);
