import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { parseUnits } from "viem";
import { db } from "../db/index.js";
import { requireAuth } from "../auth.js";
import { ApiError, asyncRoute } from "../http.js";
import { escrowAccount, transfer, userBalance } from "../ledger.js";
import { decryptPayload, encryptPayload, payloadContext, payloadDigest } from "../crypto.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { evidenceUrl, isSafeEvidenceUrl } from "../evidence.js";
import { createFundingQuote, ensureEscrowWallet, verifyOnchainFunding } from "../escrow.js";
import { planSettlement, processSettlement } from "../settlement.js";
import { enqueueWebhookEvent } from "../webhooks.js";
import type { SettlementAsset } from "../assets.js";
import {
  evaluatorPosition,
  lockEvaluator,
  MINIMUM_EVALUATOR_STAKE_USDG,
  SELF_SETTLEMENT_LIMIT_USDG,
  STAKE_COVERAGE,
} from "../capacity.js";

const jobInput = z
  .object({
    agentId: z.string().uuid(),
    evaluatorId: z.string().uuid().optional(),
    kind: z
      .enum(["standard", "trade_stock_token", "manage_vault", "subscription", "fund_transfer"])
      .default("standard"),
    title: z.string().min(3).max(160),
    brief: z.string().min(1).max(100_000).optional(),
    briefCiphertext: z.string().min(1).max(100_000).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
    budgetUsdg: z.coerce.number().positive().optional(),
    evaluatorFeeUsdg: z.coerce.number().min(0).default(0),
    budgetLiege: z.coerce.number().positive().optional(),
    evaluatorFeeLiege: z.coerce.number().min(0).default(0),
    deadlineAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    strategyPolicy: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    const budget = value.settlementAsset === "liege" ? value.budgetLiege : value.budgetUsdg;
    if (!budget)
      ctx.addIssue({
        code: "custom",
        path: [value.settlementAsset === "liege" ? "budgetLiege" : "budgetUsdg"],
        message: `${value.settlementAsset === "liege" ? "budgetLiege" : "budgetUsdg"} is required.`,
      });
    if (!value.brief && !value.briefCiphertext)
      ctx.addIssue({ code: "custom", message: "brief is required." });
    if (value.deadlineAt.getTime() <= Date.now())
      ctx.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "deadlineAt must be in the future.",
      });
    if (value.expiresAt < value.deadlineAt)
      ctx.addIssue({ code: "custom", message: "expiresAt cannot precede deadlineAt." });
    const fee =
      value.settlementAsset === "liege" ? value.evaluatorFeeLiege : value.evaluatorFeeUsdg;
    if (!value.evaluatorId && fee > 0)
      ctx.addIssue({
        code: "custom",
        path: [value.settlementAsset === "liege" ? "evaluatorFeeLiege" : "evaluatorFeeUsdg"],
        message: "An evaluator is required when an evaluator fee is configured.",
      });
  });

export const jobsRouter = Router();

// The encrypted brief is only useful to the server; clients receive it decrypted on GET /:id.
const publicJob = ({ brief_ciphertext: _ciphertext, ...job }: Record<string, unknown>) => job;

jobsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        status: z
          .enum([
            "open",
            "funded",
            "submitted",
            "completed",
            "rejected",
            "expired",
            "cancelled",
            "challenged",
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT j.*, a.name AS agent_name, a.slug AS agent_slug, ew.address AS escrow_address FROM jobs j JOIN agents a ON a.id = j.agent_id LEFT JOIN escrow_wallets ew ON ew.job_id = j.id
     WHERE (j.client_id = $1 OR a.owner_id = $1 OR j.evaluator_id = $1) AND ($2::job_status IS NULL OR j.status = $2)
     ORDER BY j.created_at DESC LIMIT $3`,
      [request.auth!.userId, query.status ?? null, query.limit],
    );
    response.json({ data: result.rows.map(publicJob) });
  }),
);

jobsRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    if (env.ESCROW_MODE === "onchain") {
      const migrated = await db.query<{ id: string }>(
        "UPDATE jobs SET escrow_mode = 'onchain', updated_at = now() WHERE id = $1 AND client_id = $2 AND status = 'open' AND escrow_mode = 'ledger' AND expires_at > now() + ($3::int * interval '1 second') RETURNING id",
        [id, request.auth!.userId, env.ESCROW_QUOTE_TTL_SECONDS],
      );
      if (migrated.rowCount) await ensureEscrowWallet(db, id);
    }
    const result = await db.query(
      `SELECT j.*, a.owner_id AS provider_id, a.name AS agent_name, a.slug AS agent_slug,
      s.deliverable_ciphertext, s.evidence AS submission_evidence, s.created_at AS delivery_created_at,
      e.outcome AS evaluation_outcome, e.rationale_ciphertext, e.created_at AS evaluation_created_at,
      es.status AS settlement_status
    FROM jobs j JOIN agents a ON a.id = j.agent_id
    LEFT JOIN submissions s ON s.job_id = j.id
    LEFT JOIN evaluations e ON e.job_id = j.id
    LEFT JOIN escrow_wallets ew ON ew.job_id = j.id
    LEFT JOIN escrow_settlements es ON es.job_id = j.id
    WHERE j.id = $1 AND (j.client_id = $2 OR a.owner_id = $2 OR j.evaluator_id = $2)`,
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(
        404,
        "job_not_found",
        "This job does not exist or is not available to this account.",
      );
    const job = result.rows[0];
    response.json({
      data: {
        ...job,
        brief: decryptPayload(job.brief_ciphertext, payloadContext(id, "brief")),
        brief_ciphertext: undefined,
        submission: job.deliverable_ciphertext
          ? {
              deliverable: decryptPayload(
                job.deliverable_ciphertext,
                payloadContext(id, "deliverable"),
              ),
              // Rows written before https-only validation may hold other schemes.
              evidence: (job.submission_evidence ?? []).filter(isSafeEvidenceUrl),
              createdAt: job.delivery_created_at,
            }
          : null,
        evaluation: job.rationale_ciphertext
          ? {
              outcome: job.evaluation_outcome,
              rationale: decryptPayload(job.rationale_ciphertext, payloadContext(id, "rationale")),
              createdAt: job.evaluation_created_at,
            }
          : null,
        deliverable_ciphertext: undefined,
        rationale_ciphertext: undefined,
        submission_evidence: undefined,
        delivery_created_at: undefined,
        evaluation_outcome: undefined,
        evaluation_created_at: undefined,
      },
    });
  }),
);

jobsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = jobInput.parse(request.body);
    const settlementAsset = input.settlementAsset as SettlementAsset;
    const budget = settlementAsset === "liege" ? input.budgetLiege! : input.budgetUsdg!;
    const evaluatorFee =
      settlementAsset === "liege" ? input.evaluatorFeeLiege : input.evaluatorFeeUsdg;
    const agent = await db.query<{ owner_id: string }>(
      "SELECT owner_id FROM agents WHERE id = $1 AND active",
      [input.agentId],
    );
    if (!agent.rowCount)
      throw new ApiError(404, "agent_not_found", "The selected agent is unavailable.");
    if (agent.rows[0].owner_id === request.auth!.userId)
      throw new ApiError(
        422,
        "self_hire_not_allowed",
        "An owner cannot open a job for their own agent.",
      );
    if (input.evaluatorId === agent.rows[0].owner_id)
      throw new ApiError(
        422,
        "provider_cannot_evaluate",
        "An agent owner cannot evaluate their own job.",
      );
    const selfSettled = !input.evaluatorId || input.evaluatorId === request.auth!.userId;
    if (selfSettled && settlementAsset === "usdg" && budget >= SELF_SETTLEMENT_LIMIT_USDG)
      throw new ApiError(
        422,
        "self_evaluation_limit",
        `Jobs of ${SELF_SETTLEMENT_LIMIT_USDG} USDG or more need an independent evaluator.`,
      );
    const privateBrief = input.brief ?? input.briefCiphertext!;
    // Chosen here so the encrypted brief can be bound to its job.
    const jobId = randomUUID();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      if (input.evaluatorId) {
        const evaluator = await lockEvaluator(client, input.evaluatorId);
        const position = evaluator
          ? await evaluatorPosition(client, input.evaluatorId, {
              addedExposureUsdg: settlementAsset === "usdg" ? budget : 0,
            })
          : null;
        if (!evaluator?.active || position!.stakeUsdg < MINIMUM_EVALUATOR_STAKE_USDG)
          throw new ApiError(
            422,
            "evaluator_ineligible",
            `The selected evaluator must have an active profile with at least ${MINIMUM_EVALUATOR_STAKE_USDG.toLocaleString("en-US")} USDG staked.`,
          );
        if (!position!.covered)
          throw new ApiError(
            422,
            "evaluator_capacity_exceeded",
            `The evaluator's stake must cover ${STAKE_COVERAGE} times the budgets of all their open jobs, including this one.`,
          );
      }
      const result = await client.query(
        `INSERT INTO jobs (id, client_id, agent_id, evaluator_id, kind, title, brief_ciphertext, brief_hash, acceptance_criteria, settlement_asset, budget_amount, evaluator_fee_amount, budget_usdg, evaluator_fee_usdg, deadline_at, expires_at, strategy_policy, escrow_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [
          jobId,
          request.auth!.userId,
          input.agentId,
          input.evaluatorId ?? null,
          input.kind,
          input.title,
          encryptPayload(privateBrief, payloadContext(jobId, "brief")),
          payloadDigest(privateBrief),
          JSON.stringify(input.acceptanceCriteria),
          settlementAsset,
          budget,
          evaluatorFee,
          settlementAsset === "usdg" ? budget : null,
          settlementAsset === "usdg" ? evaluatorFee : null,
          input.deadlineAt,
          input.expiresAt,
          input.strategyPolicy ? JSON.stringify(input.strategyPolicy) : null,
          env.ESCROW_MODE,
        ],
      );
      const job = result.rows[0];
      const escrow =
        env.ESCROW_MODE === "onchain" ? await ensureEscrowWallet(client, job.id) : null;
      await client.query(
        "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1, $2, $3)",
        [job.id, request.auth!.userId, "job.opened"],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "job.opened",
        targetType: "job",
        targetId: job.id,
        requestId: request.requestId,
      });
      await client.query("COMMIT");
      response.status(201).json({ data: { ...publicJob(job), escrow } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

async function transition(
  client: PoolClient,
  request: Parameters<typeof asyncRoute>[0] extends (request: infer R, ...args: never[]) => unknown
    ? R
    : never,
  next: "funded" | "submitted" | "completed" | "rejected",
) {
  const id = z.string().uuid().parse(request.params.id);
  const job = await client.query(
    "SELECT j.*, a.owner_id AS provider_id, j.deadline_at <= now() AS past_deadline, j.expires_at <= now() AS past_expiry FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j",
    [id],
  );
  if (!job.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
  const value = job.rows[0];
  const allowed: Record<string, string[]> = {
    funded: ["open"],
    submitted: ["funded"],
    completed: ["submitted"],
    rejected: ["submitted"],
  };
  if (!allowed[next].includes(value.status))
    throw new ApiError(
      409,
      "invalid_job_transition",
      `A ${value.status} job cannot move to ${next}.`,
    );
  if (next === "funded" && value.client_id !== request.auth!.userId)
    throw new ApiError(403, "not_client", "Only the client can record funding.");
  if (next === "submitted" && value.provider_id !== request.auth!.userId)
    throw new ApiError(403, "not_provider", "Only the agent owner can submit work.");
  if (["completed", "rejected"].includes(next)) {
    if (
      value.evaluator_id
        ? value.evaluator_id !== request.auth!.userId
        : value.client_id !== request.auth!.userId
    )
      throw new ApiError(
        403,
        value.evaluator_id ? "not_evaluator" : "not_client",
        value.evaluator_id
          ? "Only the assigned evaluator can settle this job."
          : "Only the job client can settle a job without an evaluator.",
      );
  }
  // Time limits are enforced here rather than left to the expiry job, so the outcome does not
  // depend on when that job last ran. On-chain deposits are still recorded after the deadline:
  // the funds have already moved, and recording them lets expiry refund them.
  if (next === "funded" && value.escrow_mode === "ledger" && value.past_deadline)
    throw new ApiError(
      409,
      "job_deadline_passed",
      "This job's delivery deadline has passed, so it can no longer be funded.",
    );
  if (next === "submitted" && value.past_deadline)
    throw new ApiError(
      409,
      "job_deadline_passed",
      "The delivery deadline for this job has passed.",
    );
  if ((next === "completed" || next === "rejected") && value.past_expiry)
    throw new ApiError(
      409,
      "job_expired",
      "This job has expired and can no longer be settled; its escrow is refunded to the client.",
    );
  return value;
}

jobsRouter.post(
  "/:id/funding-quote",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    if (env.ESCROW_MODE === "onchain") {
      const migrated = await db.query<{ id: string }>(
        "UPDATE jobs SET escrow_mode = 'onchain', updated_at = now() WHERE id = $1 AND client_id = $2 AND status = 'open' AND escrow_mode = 'ledger' RETURNING id",
        [id, request.auth!.userId],
      );
      if (migrated.rowCount) await ensureEscrowWallet(db, id);
    }
    const job = await db.query<{
      client_id: string;
      status: string;
      escrow_mode: string;
      settlement_asset: SettlementAsset;
      budget_amount: string;
      evaluator_fee_amount: string;
      address: string;
      expires_at: Date;
    }>(
      "SELECT j.client_id, j.status, j.escrow_mode, COALESCE(j.settlement_asset, 'usdg') AS settlement_asset, COALESCE(j.budget_amount, j.budget_usdg) AS budget_amount, CASE WHEN COALESCE(j.settlement_asset, 'usdg') = 'usdg' THEN COALESCE(j.evaluator_fee_usdg, j.evaluator_fee_amount, 0) ELSE COALESCE(j.evaluator_fee_amount, 0) END AS evaluator_fee_amount, j.expires_at, ew.address FROM jobs j LEFT JOIN escrow_wallets ew ON ew.job_id = j.id WHERE j.id = $1",
      [id],
    );
    if (!job.rowCount || job.rows[0].client_id !== request.auth!.userId)
      throw new ApiError(404, "job_not_found", "This job is not available to this account.");
    if (
      job.rows[0].status !== "open" ||
      job.rows[0].escrow_mode !== "onchain" ||
      !job.rows[0].address
    )
      throw new ApiError(
        409,
        "onchain_funding_unavailable",
        "This job is not ready for on-chain funding.",
      );
    if (job.rows[0].expires_at.getTime() <= Date.now() + env.ESCROW_QUOTE_TTL_SECONDS * 1000)
      throw new ApiError(
        409,
        "funding_quote_near_expiry",
        "This job expires too soon to safely fund.",
      );
    response.json({
      data: {
        escrowAddress: job.rows[0].address,
        usdgTokenAddress: env.USDG_TOKEN_ADDRESS,
        usdgDecimals: env.USDG_DECIMALS,
        settlementAsset: job.rows[0].settlement_asset,
        tokenAddress:
          job.rows[0].settlement_asset === "liege"
            ? env.LIEGE_TOKEN_ADDRESS
            : env.USDG_TOKEN_ADDRESS,
        tokenDecimals:
          job.rows[0].settlement_asset === "liege" ? env.LIEGE_DECIMALS : env.USDG_DECIMALS,
        tokenAmountRaw: (
          parseUnits(
            job.rows[0].budget_amount,
            job.rows[0].settlement_asset === "liege" ? env.LIEGE_DECIMALS : env.USDG_DECIMALS,
          ) +
          parseUnits(
            job.rows[0].evaluator_fee_amount,
            job.rows[0].settlement_asset === "liege" ? env.LIEGE_DECIMALS : env.USDG_DECIMALS,
          )
        ).toString(),
        ...(job.rows[0].settlement_asset === "usdg"
          ? {
              usdgAmountRaw: (
                parseUnits(job.rows[0].budget_amount, env.USDG_DECIMALS) +
                parseUnits(job.rows[0].evaluator_fee_amount, env.USDG_DECIMALS)
              ).toString(),
            }
          : {}),
        ...(await createFundingQuote(db, id)),
      },
    });
  }),
);

jobsRouter.post(
  "/:id/fund",
  requireAuth,
  asyncRoute(async (request, response) => {
    const onchainInput = z
      .object({
        quoteId: z.string().uuid(),
        tokenTxHash: z.string().optional(),
        usdgTxHash: z.string().optional(),
        gasTxHash: z.string(),
      })
      .safeParse(request.body);
    const id = z.string().uuid().parse(request.params.id);
    // On-chain deposits are verified before the transaction opens, so waiting for confirmations
    // holds neither the job lock nor a pooled connection. The transaction re-checks the job.
    const current = await db.query<{
      client_id: string;
      status: string;
      escrow_mode: string;
      settlement_asset: SettlementAsset;
      budget_amount: string;
      evaluator_fee_amount: string;
      budget_usdg: string;
      evaluator_fee_usdg: string;
    }>(
      "SELECT client_id, status, escrow_mode, COALESCE(settlement_asset, 'usdg') AS settlement_asset, COALESCE(budget_amount, budget_usdg) AS budget_amount, CASE WHEN COALESCE(settlement_asset, 'usdg') = 'usdg' THEN COALESCE(evaluator_fee_usdg, evaluator_fee_amount, 0) ELSE COALESCE(evaluator_fee_amount, 0) END AS evaluator_fee_amount, budget_usdg, evaluator_fee_usdg FROM jobs WHERE id = $1",
      [id],
    );
    const verifying =
      current.rows[0]?.escrow_mode === "onchain" &&
      current.rows[0].status === "open" &&
      current.rows[0].client_id === request.auth!.userId;
    if (verifying && !onchainInput.success)
      throw new ApiError(
        422,
        "onchain_funding_payload_required",
        "quoteId, tokenTxHash, and gasTxHash are required for on-chain funding.",
      );
    const funding =
      verifying && onchainInput.success
        ? await verifyOnchainFunding(db, onchainInput.data, {
            jobId: id,
            clientAddress: request.auth!.walletAddress,
            budget: current.rows[0].budget_amount,
            evaluatorFee: current.rows[0].evaluator_fee_amount,
            asset: current.rows[0].settlement_asset,
          })
        : null;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const job = await transition(client, request, "funded");
      if (job.escrow_mode === "onchain") {
        if (!funding)
          throw new ApiError(
            409,
            "funding_retry_required",
            "This job's escrow mode changed while funding was verified. Retry funding.",
          );
        await client.query(
          "INSERT INTO escrow_fundings (job_id, usdg_tx_hash, gas_tx_hash, usdg_amount_raw, gas_amount_wei, token_tx_hash, token_amount_raw, settlement_asset) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            job.id,
            funding.usdgTxHash,
            funding.gasTxHash,
            funding.usdgAmountRaw,
            funding.gasAmountWei,
            funding.tokenTxHash,
            funding.tokenAmountRaw,
            current.rows[0].settlement_asset,
          ],
        );
      } else {
        const total = Number(job.budget_amount) + Number(job.evaluator_fee_amount);
        const available = await userBalance(
          client,
          request.auth!.userId,
          "available",
          job.settlement_asset,
        );
        await transfer(client, {
          reference: `job-fund:${job.id}`,
          type: "job_fund",
          from: available.accountId,
          to: await escrowAccount(client, job.id, job.settlement_asset),
          asset: job.settlement_asset,
          amount: total,
          createdBy: request.auth!.userId,
          metadata: { jobId: job.id },
          insufficientFunds: new ApiError(
            422,
            "insufficient_available_balance",
            `Your available ${job.settlement_asset === "liege" ? "LIEGE" : "USDG"} balance cannot fund this job.`,
          ),
        });
      }
      const result = await client.query(
        "UPDATE jobs SET status = 'funded', funded_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [job.id],
      );
      await client.query(
        "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)",
        [job.id, request.auth!.userId, "job.funded"],
      );
      await enqueueWebhookEvent(client, {
        jobId: job.id,
        eventType: "job.funded",
        actorId: request.auth!.userId,
      });
      await client.query("COMMIT");
      response.json({ data: publicJob(result.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.post(
  "/:id/submit",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        deliverable: z.string().min(1).max(100_000).optional(),
        deliverableCiphertext: z.string().min(1).max(100_000).optional(),
        evidence: z.array(evidenceUrl).max(20).default([]),
      })
      .refine(
        (value) => Boolean(value.deliverable || value.deliverableCiphertext),
        "deliverable is required.",
      )
      .parse(request.body);
    const payload = input.deliverable ?? input.deliverableCiphertext!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const job = await transition(client, request, "submitted");
      await client.query(
        "INSERT INTO submissions (job_id, provider_id, deliverable_ciphertext, deliverable_hash, evidence) VALUES ($1,$2,$3,$4,$5)",
        [
          job.id,
          request.auth!.userId,
          encryptPayload(payload, payloadContext(job.id, "deliverable")),
          payloadDigest(payload),
          JSON.stringify(input.evidence),
        ],
      );
      const result = await client.query(
        "UPDATE jobs SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [job.id],
      );
      await client.query(
        "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)",
        [job.id, request.auth!.userId, "job.submitted"],
      );
      await enqueueWebhookEvent(client, {
        jobId: job.id,
        eventType: "job.submitted",
        actorId: request.auth!.userId,
      });
      await client.query("COMMIT");
      response.json({ data: publicJob(result.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.post(
  "/:id/evaluate",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        outcome: z.enum(["accepted", "rejected"]),
        rationale: z.string().min(1).max(100_000).optional(),
        rationaleCiphertext: z.string().min(1).max(100_000).optional(),
      })
      .refine(
        (value) => Boolean(value.rationale || value.rationaleCiphertext),
        "rationale is required.",
      )
      .parse(request.body);
    const rationale = input.rationale ?? input.rationaleCiphertext!;
    const target = input.outcome === "accepted" ? "completed" : "rejected";
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const job = await transition(client, request, target);
      const jobEvaluatorFee =
        job.settlement_asset === "usdg"
          ? Number(job.evaluator_fee_usdg ?? job.evaluator_fee_amount ?? 0)
          : Number(job.evaluator_fee_amount ?? 0);
      if (job.escrow_mode === "onchain") {
        const addresses = await client.query<{
          client_address: string;
          provider_address: string;
          evaluator_address: string;
        }>(
          `SELECT c.wallet_address AS client_address, p.wallet_address AS provider_address, COALESCE(e.wallet_address, c.wallet_address) AS evaluator_address FROM jobs j JOIN users c ON c.id = j.client_id JOIN users p ON p.id = $1 LEFT JOIN users e ON e.id = j.evaluator_id WHERE j.id = $2`,
          [job.provider_id, job.id],
        );
        if (!addresses.rowCount)
          throw new ApiError(
            409,
            "escrow_participants_missing",
            "The on-chain escrow participants are incomplete.",
          );
        // Only the plan is committed here; the transfers are sent after commit.
        await planSettlement(client, {
          jobId: job.id,
          outcome: input.outcome,
          cause: "evaluation",
          funded: true,
          clientAddress: addresses.rows[0].client_address,
          providerAddress: addresses.rows[0].provider_address,
          evaluatorAddress: addresses.rows[0].evaluator_address,
          budget: String(job.budget_amount),
          evaluatorFee: String(jobEvaluatorFee),
          asset: job.settlement_asset,
        });
      } else {
        const escrow = await escrowAccount(client, job.id, job.settlement_asset);
        const total = Number(job.budget_amount) + jobEvaluatorFee;
        if (target === "completed") {
          const provider = await userBalance(
            client,
            job.provider_id,
            "available",
            job.settlement_asset,
          );
          const evaluator = await userBalance(
            client,
            request.auth!.userId,
            "available",
            job.settlement_asset,
          );
          await transfer(client, {
            reference: `job-settle-provider:${job.id}`,
            type: "job_settlement",
            from: escrow,
            to: provider.accountId,
            amount: Number(job.budget_amount),
            asset: job.settlement_asset,
            createdBy: request.auth!.userId,
            metadata: { jobId: job.id },
          });
          if (jobEvaluatorFee > 0)
            await transfer(client, {
              reference: `job-settle-evaluator:${job.id}`,
              type: "evaluator_fee",
              from: escrow,
              to: evaluator.accountId,
              amount: jobEvaluatorFee,
              asset: job.settlement_asset,
              createdBy: request.auth!.userId,
              metadata: { jobId: job.id },
            });
        } else {
          const clientBalance = await userBalance(
            client,
            job.client_id,
            "available",
            job.settlement_asset,
          );
          await transfer(client, {
            reference: `job-refund:${job.id}`,
            type: "job_refund",
            from: escrow,
            to: clientBalance.accountId,
            amount: total,
            asset: job.settlement_asset,
            createdBy: request.auth!.userId,
            metadata: { jobId: job.id },
          });
        }
      }
      await client.query(
        "INSERT INTO evaluations (job_id, evaluator_id, outcome, rationale_ciphertext, rationale_hash) VALUES ($1,$2,$3,$4,$5)",
        [
          job.id,
          request.auth!.userId,
          input.outcome,
          encryptPayload(rationale, payloadContext(job.id, "rationale")),
          payloadDigest(rationale),
        ],
      );
      const result = await client.query(
        `UPDATE jobs SET status = '${target}', settled_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [job.id],
      );
      await client.query(
        "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)",
        [job.id, request.auth!.userId, `job.${target}`],
      );
      await enqueueWebhookEvent(client, {
        jobId: job.id,
        eventType: `job.${target}`,
        actorId: request.auth!.userId,
      });
      await client.query("COMMIT");
      response.json({ data: publicJob(result.rows[0]) });
      // Failures are recorded on the payout rows; the settle-escrows cron retries them.
      if (job.escrow_mode === "onchain")
        void processSettlement(job.id).catch((error) =>
          console.error(`Escrow settlement for job ${job.id} could not start:`, error),
        );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
