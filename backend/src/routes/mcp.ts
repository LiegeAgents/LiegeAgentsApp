import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { decryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { isSafeEvidenceUrl } from "../evidence.js";
import { ApiError, asyncRoute } from "../http.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const connectionInput = z.object({ agentId: z.string().uuid(), name: z.string().min(2).max(80) });
const proposalInput = z.object({
  action: z.enum(["accept_job", "submit_deliverable", "update_agent"]),
  payload: z.record(z.unknown()),
});
const policyInput = z.object({
  maxSpendPerJob: z.coerce.number().positive().nullable().optional(),
  maxDailySpend: z.coerce.number().positive().nullable().optional(),
  allowedJobCategories: z.array(z.string().min(1).max(80)).max(50).default([]),
  approvedCounterparties: z.array(z.string().min(1).max(120)).max(100).default([]),
  payloadAccess: z.enum(["none", "metadata", "brief", "full"]).default("full"),
  approvalMode: z.enum(["always", "within_policy"]).default("always"),
  allowedActions: z
    .array(z.enum(["accept_job", "submit_deliverable", "update_agent"]))
    .min(1)
    .default(["accept_job", "submit_deliverable", "update_agent"]),
});

type AgentPolicy = {
  agentId: string;
  version: number;
  maxSpendPerJob: number | null;
  maxDailySpend: number | null;
  allowedJobCategories: string[];
  approvedCounterparties: string[];
  payloadAccess: "none" | "metadata" | "brief" | "full";
  approvalMode: "always" | "within_policy";
  allowedActions: string[];
  updatedAt: unknown;
};
const publicPolicy = (row: Record<string, unknown> | undefined, agentId: string): AgentPolicy => ({
  agentId,
  version: Number(row?.version ?? 1),
  maxSpendPerJob: row?.max_spend_per_job == null ? null : Number(row.max_spend_per_job),
  maxDailySpend: row?.max_daily_spend == null ? null : Number(row.max_daily_spend),
  allowedJobCategories: (row?.allowed_job_categories as string[] | undefined) ?? [],
  approvedCounterparties: (row?.approved_counterparties as string[] | undefined) ?? [],
  payloadAccess: (row?.payload_access as AgentPolicy["payloadAccess"] | undefined) ?? "full",
  approvalMode: (row?.approval_mode as AgentPolicy["approvalMode"] | undefined) ?? "always",
  allowedActions: (row?.allowed_actions as string[] | undefined) ?? [
    "accept_job",
    "submit_deliverable",
    "update_agent",
  ],
  updatedAt: row?.updated_at ?? null,
});

async function ownedAgent(agentId: string, userId: string) {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM agents WHERE id = $1 AND owner_id = $2",
    [agentId, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
}

async function policyFor(agentId: string) {
  const result = await db.query("SELECT * FROM agent_approval_policies WHERE agent_id = $1", [
    agentId,
  ]);
  return publicPolicy(result.rows[0], agentId);
}

const internal = (value: string | undefined) => {
  if (!value || !env.MCP_INTERNAL_API_TOKEN) return false;
  const expected = Buffer.from(env.MCP_INTERNAL_API_TOKEN);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

async function connection(request: { header(name: string): string | undefined }) {
  if (!internal(request.header("x-mcp-internal-token")))
    throw new ApiError(401, "invalid_mcp_service", "A valid MCP service token is required.");
  const token = request.header("x-mcp-connection-token");
  if (!token)
    throw new ApiError(401, "invalid_mcp_connection", "An MCP connection token is required.");
  const result = await db.query<{
    id: string;
    user_id: string;
    agent_id: string;
    agent_name: string;
  }>(
    `SELECT c.id, c.user_id, c.agent_id, a.name AS agent_name FROM mcp_connections c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND c.expires_at > now()`,
    [hash(token)],
  );
  if (!result.rowCount)
    throw new ApiError(401, "invalid_mcp_connection", "This MCP connection is invalid or expired.");
  return result.rows[0];
}

export const mcpRouter = Router();
mcpRouter.post(
  "/connections",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = connectionInput.parse(request.body);
    const owned = await db.query("SELECT id FROM agents WHERE id = $1 AND owner_id = $2", [
      input.agentId,
      request.auth!.userId,
    ]);
    if (!owned.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    const token = `lmp_${randomBytes(32).toString("hex")}`;
    const result = await db.query<{ id: string; expires_at: Date }>(
      "INSERT INTO mcp_connections (user_id, agent_id, name, token_hash, expires_at) VALUES ($1,$2,$3,$4,now() + interval '30 days') RETURNING id, expires_at",
      [request.auth!.userId, input.agentId, input.name, hash(token)],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.connection_created",
      targetType: "mcp_connection",
      targetId: result.rows[0].id,
      requestId: request.requestId,
      metadata: { agentId: input.agentId },
    });
    response
      .status(201)
      .json({ data: { id: result.rows[0].id, token, expiresAt: result.rows[0].expires_at } });
  }),
);
mcpRouter.get(
  "/connections",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "SELECT id, agent_id, name, expires_at, revoked_at, created_at FROM mcp_connections WHERE user_id = $1 ORDER BY created_at DESC",
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);
mcpRouter.get(
  "/policies/:agentId",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ownedAgent(agentId, request.auth!.userId);
    response.json({ data: await policyFor(agentId) });
  }),
);
mcpRouter.put(
  "/policies/:agentId",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ownedAgent(agentId, request.auth!.userId);
    const input = policyInput.parse(request.body);
    const result = await db.query(
      `INSERT INTO agent_approval_policies
       (agent_id, version, max_spend_per_job, max_daily_spend, allowed_job_categories, approved_counterparties, payload_access, approval_mode, allowed_actions, updated_by)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (agent_id) DO UPDATE SET
         version = agent_approval_policies.version + 1,
         max_spend_per_job = EXCLUDED.max_spend_per_job,
         max_daily_spend = EXCLUDED.max_daily_spend,
         allowed_job_categories = EXCLUDED.allowed_job_categories,
         approved_counterparties = EXCLUDED.approved_counterparties,
         payload_access = EXCLUDED.payload_access,
         approval_mode = EXCLUDED.approval_mode,
         allowed_actions = EXCLUDED.allowed_actions,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        agentId,
        input.maxSpendPerJob ?? null,
        input.maxDailySpend ?? null,
        input.allowedJobCategories,
        input.approvedCounterparties.map((value) => value.toLowerCase()),
        input.payloadAccess,
        input.approvalMode,
        input.allowedActions,
        request.auth!.userId,
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.policy_updated",
      targetType: "agent",
      targetId: agentId,
      requestId: request.requestId,
      metadata: { version: result.rows[0].version },
    });
    response.json({ data: publicPolicy(result.rows[0], agentId) });
  }),
);
mcpRouter.delete(
  "/connections/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "UPDATE mcp_connections SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "connection_not_found", "This MCP connection is unavailable.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.connection_revoked",
      targetType: "mcp_connection",
      targetId: id,
      requestId: request.requestId,
    });
    response.status(204).end();
  }),
);
mcpRouter.get(
  "/proposals",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "SELECT id, agent_id, action, payload, status, expires_at, created_at, decided_at FROM mcp_proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);
mcpRouter.post(
  "/proposals/:id/:decision",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const decision = z.enum(["approved", "rejected"]).parse(request.params.decision);
    const result = await db.query(
      "UPDATE mcp_proposals SET status = $3, decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now() RETURNING id, status",
      [id, request.auth!.userId, decision],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        "proposal_unavailable",
        "This proposal is no longer available to decide.",
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: `mcp.proposal_${decision}`,
      targetType: "mcp_proposal",
      targetId: id,
      requestId: request.requestId,
    });
    response.json({ data: result.rows[0] });
  }),
);

export const mcpInternalRouter = Router();
mcpInternalRouter.get(
  "/session",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    response.json({ data: { agentId: c.agent_id, agentName: c.agent_name } });
  }),
);
mcpInternalRouter.get(
  "/jobs",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const policy = await policyFor(c.agent_id);
    const jobs = await db.query(
      "SELECT id, public_id, title, status, kind, settlement_asset, budget_amount, budget_usdg, deadline_at, expires_at, created_at FROM jobs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100",
      [c.agent_id],
    );
    response.json({ data: jobs.rows, policy });
  }),
);
mcpInternalRouter.get(
  "/jobs/:id",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `SELECT j.id, j.public_id, j.title, j.kind, j.status, j.brief_ciphertext, j.acceptance_criteria,
        j.budget_usdg, j.deadline_at, j.expires_at, s.deliverable_ciphertext, s.evidence,
        s.created_at AS delivery_created_at
       FROM jobs j
       LEFT JOIN submissions s ON s.job_id = j.id
       WHERE j.id = $1 AND j.agent_id = $2`,
      [id, c.agent_id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "job_not_found", "This job is not assigned to the connected agent.");
    const job = result.rows[0];
    const policy = await policyFor(c.agent_id);
    if (policy.payloadAccess === "none") {
      response.json({
        data: {
          id: job.id,
          public_id: job.public_id,
          title: job.title,
          kind: job.kind,
          status: job.status,
          budget_usdg: job.budget_usdg,
          deadline_at: job.deadline_at,
          expires_at: job.expires_at,
        },
      });
      return;
    }
    response.json({
      data: {
        ...job,
        brief:
          policy.payloadAccess === "metadata"
            ? undefined
            : decryptPayload(job.brief_ciphertext, payloadContext(id, "brief")),
        brief_ciphertext: undefined,
        submission:
          policy.payloadAccess === "metadata"
            ? null
            : job.deliverable_ciphertext
              ? {
                  deliverable: decryptPayload(
                    job.deliverable_ciphertext,
                    payloadContext(id, "deliverable"),
                  ),
                  evidence: (job.evidence ?? []).filter(isSafeEvidenceUrl),
                  createdAt: job.delivery_created_at,
                }
              : null,
        deliverable_ciphertext: undefined,
        evidence: undefined,
        delivery_created_at: undefined,
      },
    });
  }),
);
mcpInternalRouter.post(
  "/proposals",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const input = proposalInput.parse(request.body);
    const policy = await policyFor(c.agent_id);
    if (!policy.allowedActions.includes(input.action))
      throw new ApiError(
        403,
        "policy_action_denied",
        "This action is not allowed by the agent policy.",
      );
    const violations: string[] = [];
    if (input.action === "accept_job") {
      const jobId = z.string().uuid().safeParse(input.payload.jobId);
      if (!jobId.success) violations.push("A valid jobId is required.");
      else {
        const job = await db.query<{
          kind: string;
          client_id: string;
          wallet_address: string;
          amount: string;
        }>(
          `SELECT j.kind, j.client_id, u.wallet_address, COALESCE(j.budget_amount, j.budget_usdg) AS amount
           FROM jobs j JOIN users u ON u.id = j.client_id WHERE j.id = $1 AND j.agent_id = $2`,
          [jobId.data, c.agent_id],
        );
        if (job.rowCount) {
          const row = job.rows[0];
          if (policy.allowedJobCategories.length && !policy.allowedJobCategories.includes(row.kind))
            violations.push("The job category is not allowed by the agent policy.");
          if (
            policy.approvedCounterparties.length &&
            !policy.approvedCounterparties.some((value) =>
              [row.client_id, row.wallet_address.toLowerCase()].includes(value.toLowerCase()),
            )
          )
            violations.push("The client is not an approved counterparty.");
          if (policy.maxSpendPerJob != null && Number(row.amount) > policy.maxSpendPerJob)
            violations.push("The job exceeds the per-job spend limit.");
          if (policy.maxDailySpend != null) {
            const spent = await db.query<{ amount: string }>(
              "SELECT COALESCE(sum(COALESCE(budget_amount, budget_usdg)), 0) AS amount FROM jobs WHERE agent_id = $1 AND created_at >= date_trunc('day', now()) AND status <> 'cancelled'",
              [c.agent_id],
            );
            if (Number(spent.rows[0].amount) + Number(row.amount) > policy.maxDailySpend)
              violations.push("The job exceeds the daily spend limit.");
          }
        }
      }
    }
    if (violations.length) throw new ApiError(403, "policy_action_denied", violations.join(" "));
    const result = await db.query<{ id: string; expires_at: Date }>(
      "INSERT INTO mcp_proposals (connection_id, user_id, agent_id, action, payload, expires_at) VALUES ($1,$2,$3,$4,$5,now() + interval '24 hours') RETURNING id, expires_at",
      [c.id, c.user_id, c.agent_id, input.action, JSON.stringify(input.payload)],
    );
    await audit(db, {
      actorId: c.user_id,
      action: "mcp.proposal_created",
      targetType: "mcp_proposal",
      targetId: result.rows[0].id,
      metadata: { action: input.action, agentId: c.agent_id },
    });
    response.status(201).json({
      data: { id: result.rows[0].id, status: "pending", expiresAt: result.rows[0].expires_at },
    });
  }),
);
