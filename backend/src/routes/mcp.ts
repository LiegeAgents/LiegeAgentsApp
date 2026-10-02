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
import { agentActionDigest, normalizeAgentAction, ownerRuleReasons } from "../agentActions.js";
import { ensureAccount, publicAccount } from "./agentAccounts.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const connectionInput = z.object({ agentId: z.string().uuid(), name: z.string().min(2).max(80) });
const proposalInput = z.object({
  action: z.enum(["accept_job", "submit_deliverable", "update_agent", "runner.execute"]),
  payload: z.record(z.unknown()),
  simulationId: z.string().uuid().optional(),
});
const policyInput = z.object({
  maxSpendPerJob: z.coerce.number().positive().nullable().optional(),
  maxDailySpend: z.coerce.number().positive().nullable().optional(),
  maxInvoiceAmount: z.coerce.number().positive().nullable().optional(),
  allowedJobCategories: z.array(z.string().min(1).max(80)).max(50).default([]),
  approvedCounterparties: z.array(z.string().min(1).max(120)).max(100).default([]),
  payloadAccess: z.enum(["none", "metadata", "brief", "full"]).default("full"),
  approvalMode: z.enum(["always", "within_policy"]).default("always"),
  allowedActions: z
    .array(z.enum(["accept_job", "submit_deliverable", "update_agent", "runner.execute"]))
    .min(1)
    .default(["accept_job", "submit_deliverable", "update_agent", "runner.execute"]),
});

type AgentPolicy = {
  agentId: string;
  version: number;
  maxSpendPerJob: number | null;
  maxDailySpend: number | null;
  maxInvoiceAmount: number | null;
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
  maxInvoiceAmount: row?.max_invoice_amount == null ? null : Number(row.max_invoice_amount),
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

export type HarnessPresetTarget = "claude_desktop" | "cursor" | "elizaos" | "hermes" | "openclaw";

export type HarnessPreset = {
  id: HarnessPresetTarget;
  name: string;
  target: HarnessPresetTarget;
  filename: string;
  description: string;
  instructions: string;
  format: "json";
  config: Record<string, unknown>;
};

export function buildHarnessPresets(options: {
  serverName?: string;
  serverUrl?: string;
  token?: string;
  agentName?: string;
}): Record<HarnessPresetTarget, HarnessPreset> {
  const token = options.token || "<YOUR_LIEGE_MCP_TOKEN>";
  const rawName = (options.serverName || options.agentName || "liege")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const serverName = rawName || "liege";
  const url =
    options.serverUrl ||
    `${(env.MCP_PUBLIC_URL || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`;

  return {
    claude_desktop: {
      id: "claude_desktop",
      name: "Claude Desktop",
      target: "claude_desktop",
      filename: "claude_desktop_config.json",
      description: "Claude Desktop app MCP server configuration",
      instructions:
        "Paste into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows).",
      format: "json",
      config: {
        mcpServers: {
          [serverName]: {
            url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
    },
    cursor: {
      id: "cursor",
      name: "Cursor",
      target: "cursor",
      filename: ".cursor/mcp.json",
      description: "Cursor IDE remote Streamable HTTP MCP configuration",
      instructions:
        "Paste into .cursor/mcp.json at your workspace root or ~/.cursor/mcp.json globally.",
      format: "json",
      config: {
        mcpServers: {
          [serverName]: {
            url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
    },
    elizaos: {
      id: "elizaos",
      name: "ElizaOS",
      target: "elizaos",
      filename: "character.json",
      description: "ElizaOS character plugin and MCP settings configuration",
      instructions:
        "Add @elizaos/plugin-mcp to your character plugins and configure the server under settings.mcp.servers.",
      format: "json",
      config: {
        name: options.agentName || "Liege Agent",
        plugins: ["@elizaos/plugin-mcp"],
        settings: {
          mcp: {
            servers: {
              [serverName]: {
                url,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          },
        },
      },
    },
    hermes: {
      id: "hermes",
      name: "Hermes",
      target: "hermes",
      filename: "hermes.json",
      description: "Hermes autonomous agent harness tool configuration",
      instructions: "Add to your hermes.json or config.json under mcpServers.",
      format: "json",
      config: {
        mcpServers: {
          [serverName]: {
            url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
    },
    openclaw: {
      id: "openclaw",
      name: "OpenClaw",
      target: "openclaw",
      filename: "openclaw.json",
      description: "OpenClaw autonomous agent harness configuration",
      instructions: "Add to your OpenClaw agent configuration under tools.mcp.",
      format: "json",
      config: {
        tools: {
          mcp: {
            [serverName]: {
              url,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        },
      },
    },
  };
}

export const mcpRouter = Router();
mcpRouter.post(
  "/connections",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = connectionInput.parse(request.body);
    const owned = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE id = $1 AND owner_id = $2",
      [input.agentId, request.auth!.userId],
    );
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
    const serverUrl = `${(env.MCP_PUBLIC_URL || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`;
    const presets = buildHarnessPresets({
      serverName: input.name,
      serverUrl,
      token,
      agentName: owned.rows[0]?.name,
    });
    response.status(201).json({
      data: {
        id: result.rows[0].id,
        token,
        expiresAt: result.rows[0].expires_at,
        presets,
      },
    });
  }),
);
mcpRouter.get(
  "/connections/:id/presets",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const tokenQuery = typeof request.query.token === "string" ? request.query.token : undefined;
    const result = await db.query<{
      id: string;
      agent_id: string;
      name: string;
      agent_name: string;
    }>(
      `SELECT c.id, c.agent_id, c.name, a.name AS agent_name
       FROM mcp_connections c
       JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 AND c.user_id = $2 AND c.revoked_at IS NULL`,
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "connection_not_found", "This MCP connection is unavailable.");
    const row = result.rows[0];
    const serverUrl = `${(env.MCP_PUBLIC_URL || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`;
    const presets = buildHarnessPresets({
      serverName: row.name,
      serverUrl,
      token: tokenQuery,
      agentName: row.agent_name,
    });
    response.json({
      data: {
        connectionId: row.id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        connectionName: row.name,
        serverUrl,
        presets,
      },
    });
  }),
);
mcpRouter.get(
  "/presets",
  requireAuth,
  asyncRoute(async (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : undefined;
    const serverName = typeof request.query.name === "string" ? request.query.name : undefined;
    const agentId = typeof request.query.agentId === "string" ? request.query.agentId : undefined;
    let agentName: string | undefined;
    if (agentId) {
      const parsedAgentId = z.string().uuid().safeParse(agentId);
      if (parsedAgentId.success) {
        const agent = await db.query<{ name: string }>(
          "SELECT name FROM agents WHERE id = $1 AND owner_id = $2",
          [parsedAgentId.data, request.auth!.userId],
        );
        if (agent.rowCount) {
          agentName = agent.rows[0].name;
        }
      }
    }
    const serverUrl = `${(env.MCP_PUBLIC_URL || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`;
    const presets = buildHarnessPresets({
      serverName: serverName || agentName,
      serverUrl,
      token,
      agentName,
    });
    response.json({
      data: {
        serverUrl,
        presets,
      },
    });
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
       (agent_id, version, max_spend_per_job, max_daily_spend, max_invoice_amount, allowed_job_categories, approved_counterparties, payload_access, approval_mode, allowed_actions, updated_by)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (agent_id) DO UPDATE SET
         version = agent_approval_policies.version + 1,
         max_spend_per_job = EXCLUDED.max_spend_per_job,
         max_daily_spend = EXCLUDED.max_daily_spend,
         max_invoice_amount = EXCLUDED.max_invoice_amount,
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
        input.maxInvoiceAmount ?? null,
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
    const query = z
      .object({
        status: z.enum(["all", "pending", "approved", "rejected", "expired"]).default("all"),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT id, agent_id, action, payload, simulation_id, status,
        CASE WHEN status='pending' AND expires_at <= now() THEN 'expired' ELSE status END AS effective_status,
        expires_at, created_at, decided_at
       FROM mcp_proposals WHERE user_id=$1
         AND ($2='all' OR status=$2 OR ($2='expired' AND status='pending' AND expires_at <= now()))
       ORDER BY created_at DESC LIMIT 100`,
      [request.auth!.userId, query.status],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.proposals_read",
      targetType: "mcp_proposals",
      targetId: request.auth!.userId,
      requestId: request.requestId,
      metadata: { status: query.status, count: result.rowCount },
    });
    response.json({ data: result.rows });
  }),
);
mcpRouter.get(
  "/proposals/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `SELECT id, agent_id, action, payload, simulation_id, status,
        CASE WHEN status='pending' AND expires_at <= now() THEN 'expired' ELSE status END AS effective_status,
        expires_at, created_at, decided_at
       FROM mcp_proposals WHERE id=$1 AND user_id=$2`,
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "proposal_not_found", "This proposal is unavailable.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.proposal_read",
      targetType: "mcp_proposal",
      targetId: id,
      requestId: request.requestId,
      metadata: { agentId: result.rows[0].agent_id },
    });
    response.json({ data: result.rows[0] });
  }),
);
mcpRouter.post(
  "/proposals/:id/:decision",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const decision = z.enum(["approved", "rejected"]).parse(request.params.decision);
    // Approval is refused while the agent's account is paused or killed; rejection always works.
    const result = await db.query(
      `UPDATE mcp_proposals p SET status = $3, decided_at = now()
       WHERE p.id = $1 AND p.user_id = $2 AND p.status = 'pending' AND p.expires_at > now()
         AND ($3 = 'rejected' OR NOT EXISTS (
           SELECT 1 FROM agent_accounts a WHERE a.agent_id = p.agent_id AND a.status <> 'active'))
       RETURNING p.id, p.status`,
      [id, request.auth!.userId, decision],
    );
    if (!result.rowCount && decision === "approved") {
      const account = await db.query<{ status: string }>(
        `SELECT a.status FROM mcp_proposals p JOIN agent_accounts a ON a.agent_id = p.agent_id
         WHERE p.id = $1 AND p.user_id = $2 AND a.status <> 'active'`,
        [id, request.auth!.userId],
      );
      if (account.rowCount)
        throw new ApiError(
          403,
          "agent_account_paused",
          `This agent account is ${account.rows[0].status}; resume it before approving proposals.`,
        );
    }
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
const cursorFor = (createdAt: Date | string, id: string) =>
  Buffer.from(JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id })).toString(
    "base64url",
  );
const parseCursor = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error();
    return parsed as { createdAt: string; id: string };
  } catch {
    throw new ApiError(400, "invalid_cursor", "The pagination cursor is invalid or expired.");
  }
};
mcpInternalRouter.get(
  "/session",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    response.json({ data: { agentId: c.agent_id, agentName: c.agent_name } });
  }),
);
mcpInternalRouter.get(
  "/runner/:id",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `SELECT id, agent_id, job_id, command, args, status, exit_code, timeout_ms, max_output_bytes,
        stdout, stderr, error, started_at, finished_at, created_at
       FROM execution_runs WHERE id=$1 AND owner_id=$2 AND agent_id=$3`,
      [id, c.user_id, c.agent_id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "runner_not_found", "This execution run is unavailable.");
    const artifacts = await db.query(
      'SELECT id, name, size_bytes AS "sizeBytes", sha256, created_at FROM execution_artifacts WHERE run_id=$1 ORDER BY created_at',
      [id],
    );
    await audit(db, {
      actorId: c.user_id,
      action: "runner.status_read",
      targetType: "execution_run",
      targetId: id,
      requestId: request.requestId,
      metadata: { agentId: c.agent_id },
    });
    response.json({ data: { ...result.rows[0], artifacts: artifacts.rows } });
  }),
);
mcpInternalRouter.get(
  "/runner/:id/artifacts/:artifactId",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const id = z.string().uuid().parse(request.params.id);
    const artifactId = z.string().uuid().parse(request.params.artifactId);
    const result = await db.query<{ name: string; sha256: string; content_ciphertext: string }>(
      `SELECT a.name, a.sha256, a.content_ciphertext FROM execution_artifacts a
       JOIN execution_runs r ON r.id=a.run_id
       WHERE a.id=$1 AND a.run_id=$2 AND r.owner_id=$3 AND r.agent_id=$4`,
      [artifactId, id, c.user_id, c.agent_id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "artifact_not_found", "This execution artifact is unavailable.");
    await audit(db, {
      actorId: c.user_id,
      action: "runner.artifact_read",
      targetType: "execution_artifact",
      targetId: artifactId,
      requestId: request.requestId,
      metadata: { runId: id, agentId: c.agent_id, name: result.rows[0].name },
    });
    response.json({
      data: {
        name: result.rows[0].name,
        sha256: result.rows[0].sha256,
        contentBase64: decryptPayload(
          result.rows[0].content_ciphertext,
          payloadContext(id, "artifact"),
        ),
      },
    });
  }),
);
mcpInternalRouter.get(
  "/proposals",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        status: z.enum(["all", "pending", "approved", "rejected", "expired"]).default("all"),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT id, agent_id, action, payload, status,
        CASE WHEN status='pending' AND expires_at <= now() THEN 'expired' ELSE status END AS effective_status,
        expires_at, created_at, decided_at
       FROM mcp_proposals
       WHERE user_id=$1 AND agent_id=$2
         AND ($3='all' OR status=$3 OR ($3='expired' AND status='pending' AND expires_at <= now()))
       ORDER BY created_at DESC LIMIT $4`,
      [c.user_id, c.agent_id, query.status, query.limit],
    );
    await audit(db, {
      actorId: c.user_id,
      action: "mcp.proposals_read",
      targetType: "mcp_proposals",
      targetId: c.agent_id,
      metadata: { agentId: c.agent_id, status: query.status, count: result.rowCount },
    });
    response.json({ data: result.rows });
  }),
);
mcpInternalRouter.get(
  "/proposals/:id",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `SELECT id, agent_id, action, payload, status,
        CASE WHEN status='pending' AND expires_at <= now() THEN 'expired' ELSE status END AS effective_status,
        expires_at, created_at, decided_at
       FROM mcp_proposals WHERE id=$1 AND user_id=$2 AND agent_id=$3`,
      [id, c.user_id, c.agent_id],
    );
    if (!result.rowCount)
      throw new ApiError(
        404,
        "proposal_not_found",
        "This proposal is unavailable to the connected agent.",
      );
    await audit(db, {
      actorId: c.user_id,
      action: "mcp.proposal_read",
      targetType: "mcp_proposal",
      targetId: id,
      metadata: { agentId: c.agent_id },
    });
    response.json({ data: result.rows[0] });
  }),
);
mcpInternalRouter.get(
  "/jobs",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const policy = await policyFor(c.agent_id);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    const cursor = parseCursor(query.cursor);
    const jobs = await db.query(
      `SELECT id, public_id, title, status, kind, settlement_asset, budget_amount, budget_usdg, deadline_at, expires_at, created_at
       FROM jobs WHERE agent_id = $1 AND ($2::timestamptz IS NULL OR (created_at,id) < ($2::timestamptz,$3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [c.agent_id, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const rows = jobs.rows.slice(0, query.limit);
    response.json({
      data: rows,
      policy,
      nextCursor:
        jobs.rows.length > query.limit ? cursorFor(rows.at(-1).created_at, rows.at(-1).id) : null,
    });
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
    if (new Date(job.expires_at) <= new Date()) {
      await audit(db, {
        actorId: c.user_id,
        action: "job.payload_access_denied",
        targetType: "job",
        targetId: id,
        metadata: {
          payload: "job",
          role: "provider",
          code: "payload_expired",
          agentId: c.agent_id,
        },
      });
      throw new ApiError(
        410,
        "payload_expired",
        "Private payload access for this job has expired.",
      );
    }
    const policy = await policyFor(c.agent_id);
    if (policy.payloadAccess === "none") {
      await audit(db, {
        actorId: c.user_id,
        action: "job.payload_access_denied",
        targetType: "job",
        targetId: id,
        metadata: {
          payload: "brief_and_deliverable",
          role: "provider",
          code: "payload_policy_denied",
          policyVersion: policy.version,
          agentId: c.agent_id,
        },
      });
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
    await audit(db, {
      actorId: c.user_id,
      action: "job.payload_accessed",
      targetType: "job",
      targetId: id,
      metadata: {
        payload:
          policy.payloadAccess === "metadata"
            ? "metadata"
            : policy.payloadAccess === "brief"
              ? "brief"
              : "brief_and_deliverable",
        role: "provider",
        policyVersion: policy.version,
        agentId: c.agent_id,
      },
    });
    response.json({
      data: {
        ...job,
        brief:
          policy.payloadAccess === "metadata"
            ? undefined
            : decryptPayload(job.brief_ciphertext, payloadContext(id, "brief")),
        brief_ciphertext: undefined,
        submission:
          policy.payloadAccess === "metadata" || policy.payloadAccess === "brief"
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
    const account = await db.query<{ status: string }>(
      "SELECT status FROM agent_accounts WHERE agent_id=$1",
      [c.agent_id],
    );
    if (account.rowCount && account.rows[0].status !== "active")
      throw new ApiError(
        403,
        "agent_account_paused",
        `This agent account is ${account.rows[0].status} and cannot create proposals.`,
      );
    if (account.rowCount && input.simulationId) {
      const simulation = await db.query<{
        action_digest: string;
        policy_version: number;
        expires_at: Date;
      }>(
        "SELECT action_digest,policy_version,expires_at FROM agent_account_simulations WHERE id=$1 AND agent_id=$2",
        [input.simulationId, c.agent_id],
      );
      const policyVersion = (
        await db.query<{ version: number }>(
          "SELECT version FROM agent_account_policies WHERE agent_id=$1",
          [c.agent_id],
        )
      ).rows[0]?.version;
      const action = normalizeAgentAction({ action: input.action, details: input.payload });
      if (
        !simulation.rowCount ||
        simulation.rows[0].expires_at <= new Date() ||
        Number(simulation.rows[0].policy_version) !== Number(policyVersion) ||
        simulation.rows[0].action_digest !==
          agentActionDigest(c.agent_id, Number(policyVersion), action)
      )
        throw new ApiError(
          409,
          "simulation_mismatch",
          "The proposal no longer matches its simulation and policy version.",
        );
    }
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
      "INSERT INTO mcp_proposals (connection_id, user_id, agent_id, action, payload, simulation_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,now() + interval '24 hours') RETURNING id, expires_at",
      [
        c.id,
        c.user_id,
        c.agent_id,
        input.action,
        JSON.stringify(input.payload),
        input.simulationId ?? null,
      ],
    );
    await audit(db, {
      actorId: c.user_id,
      action: "mcp.proposal_created",
      targetType: "mcp_proposal",
      targetId: result.rows[0].id,
      metadata: { action: input.action, agentId: c.agent_id },
    });
    response.status(201).json({
      data: {
        id: result.rows[0].id,
        status: "pending",
        simulationId: input.simulationId ?? null,
        expiresAt: result.rows[0].expires_at,
      },
    });
  }),
);

const mcpActionSimulateInput = z.object({
  action: z.string().min(1).max(120),
  amount: z.coerce.number().nonnegative().optional(),
  asset: z.string().min(1).max(80).optional(),
  venue: z.string().min(1).max(120).optional(),
  counterparty: z.string().min(1).max(120).optional(),
  details: z.record(z.unknown()).default({}),
});

const mcpActionAuthorizeInput = z.object({
  action: z.string().min(1).max(120),
  amount: z.coerce.number().nonnegative().optional(),
  asset: z.string().min(1).max(80).optional(),
  venue: z.string().min(1).max(120).optional(),
  counterparty: z.string().min(1).max(120).optional(),
  details: z.record(z.unknown()).default({}),
  simulationId: z.string().uuid().optional(),
  simulationDigest: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{8,256}$/)
    .optional(),
  simulate: z.boolean().default(false),
});

mcpInternalRouter.get(
  "/account",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    await ensureAccount(c.agent_id, c.user_id);
    const result = await db.query(
      `SELECT a.*, p.version AS policy_version, p.max_action_amount, p.daily_budget, p.monthly_budget,
        p.allowed_assets, p.allowed_venues, p.approved_counterparties, p.allowed_actions,
        p.approval_mode, p.simulation_required, p.require_human_above, p.active_hours_start,
        p.active_hours_end, p.active_days, p.active_timezone, p.updated_at AS policy_updated_at
       FROM agent_accounts a LEFT JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1`,
      [c.agent_id],
    );
    const row = result.rows[0];
    const spentToday = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS amount FROM agent_account_actions
       WHERE agent_id=$1 AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('day', now())`,
      [c.agent_id],
    );
    const spentMonth = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS amount FROM agent_account_actions
       WHERE agent_id=$1 AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('month', now())`,
      [c.agent_id],
    );
    const dailySpent = Number(spentToday.rows[0]?.amount ?? 0);
    const monthlySpent = Number(spentMonth.rows[0]?.amount ?? 0);
    const dailyBudget = row.daily_budget == null ? null : Number(row.daily_budget);
    const monthlyBudget = row.monthly_budget == null ? null : Number(row.monthly_budget);
    const ownerRules = ownerRuleReasons(row, null);
    response.json({
      data: {
        accountId: c.agent_id,
        agentId: c.agent_id,
        agentName: c.agent_name,
        status: row.status,
        killReason: row.kill_reason,
        pausedAt: row.paused_at,
        policy: publicAccount(row).policy,
        budgetUsage: {
          dailySpent,
          dailyRemaining: dailyBudget != null ? Math.max(0, dailyBudget - dailySpent) : null,
          monthlySpent,
          monthlyRemaining:
            monthlyBudget != null ? Math.max(0, monthlyBudget - monthlySpent) : null,
        },
        activeHoursStatus: {
          currentlyActive: !ownerRules.denied.includes("outside_active_hours"),
          timezone: row.active_timezone ?? "UTC",
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  }),
);

mcpInternalRouter.post(
  "/account/simulate",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    await ensureAccount(c.agent_id, c.user_id);
    const input = mcpActionSimulateInput.parse(request.body);
    const state = await db.query(
      "SELECT a.status, p.* FROM agent_accounts a JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1",
      [c.agent_id],
    );
    const row = state.rows[0];
    const action = normalizeAgentAction(input);
    const violations: string[] = [];
    if (row.status !== "active") violations.push(`account_${row.status}`);
    if (row.allowed_actions.length && !row.allowed_actions.includes(action.action))
      violations.push("action_not_allowed");
    if (action.asset && row.allowed_assets.length && !row.allowed_assets.includes(action.asset))
      violations.push("asset_not_allowed");
    if (action.venue && row.allowed_venues.length && !row.allowed_venues.includes(action.venue))
      violations.push("venue_not_allowed");
    if (
      action.counterparty &&
      row.approved_counterparties.length &&
      !row.approved_counterparties.includes(action.counterparty)
    )
      violations.push("counterparty_not_allowed");
    const limits = await db.query<{
      action_exceeded: boolean;
      daily_exceeded: boolean;
      monthly_exceeded: boolean;
    }>(
      `SELECT
         ($2::numeric IS NOT NULL AND p.max_action_amount IS NOT NULL AND $2::numeric > p.max_action_amount) AS action_exceeded,
         ($2::numeric IS NOT NULL AND p.daily_budget IS NOT NULL AND
           COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
             AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('day', now())), 0) + $2::numeric > p.daily_budget) AS daily_exceeded,
         ($2::numeric IS NOT NULL AND p.monthly_budget IS NOT NULL AND
           COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
             AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('month', now())), 0) + $2::numeric > p.monthly_budget) AS monthly_exceeded
       FROM agent_account_policies p WHERE p.agent_id=$1`,
      [c.agent_id, action.amount],
    );
    if (limits.rows[0]?.action_exceeded) violations.push("action_limit_exceeded");
    if (limits.rows[0]?.daily_exceeded) violations.push("daily_budget_exceeded");
    if (limits.rows[0]?.monthly_exceeded) violations.push("monthly_budget_exceeded");
    const ownerRules = ownerRuleReasons(row, action.amount);
    violations.push(...ownerRules.denied);
    const actionDigest = agentActionDigest(c.agent_id, Number(row.version), action);
    const result = {
      eligible: violations.length === 0,
      violations,
      approvalRequired: row.approval_mode === "always" || ownerRules.review.length > 0,
      reviewReasons: ownerRules.review,
      policyVersion: Number(row.version),
    };
    const inserted = await db.query(
      `INSERT INTO agent_account_simulations (agent_id,policy_version,action_digest,action,result,created_by,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,now() + interval '15 minutes')
       ON CONFLICT (action_digest) DO UPDATE SET result=EXCLUDED.result, expires_at=EXCLUDED.expires_at, created_at=now()
       RETURNING id,action_digest,action,result,policy_version,expires_at,created_at`,
      [
        c.agent_id,
        row.version,
        actionDigest,
        JSON.stringify(action),
        JSON.stringify(result),
        c.user_id,
      ],
    );
    response.status(201).json({
      data: {
        id: inserted.rows[0].id,
        simulationId: inserted.rows[0].id,
        actionDigest: inserted.rows[0].action_digest,
        action,
        result,
        policyVersion: Number(inserted.rows[0].policy_version),
        expiresAt: inserted.rows[0].expires_at,
        createdAt: inserted.rows[0].created_at,
      },
    });
  }),
);

mcpInternalRouter.post(
  "/account/authorize",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    await ensureAccount(c.agent_id, c.user_id);
    const input = mcpActionAuthorizeInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query(
        "SELECT a.*, p.* FROM agent_accounts a JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1 FOR UPDATE",
        [c.agent_id],
      );
      const row = state.rows[0];
      const normalizedAction = normalizeAgentAction(input);
      let boundSimulationId: string | null = null;
      let boundDigest: string | null = null;
      if (!input.simulate && (row.simulation_required || input.simulationId)) {
        if (!input.simulationId)
          throw new ApiError(
            400,
            "simulation_required",
            "Run a simulation and provide its simulationId before authorization.",
          );
        const simulation = await client.query<{
          id: string;
          action_digest: string;
          action: Record<string, unknown>;
          policy_version: number;
          expires_at: Date;
        }>(
          "SELECT id,action_digest,action,policy_version,expires_at FROM agent_account_simulations WHERE id=$1 AND agent_id=$2 FOR UPDATE",
          [input.simulationId, c.agent_id],
        );
        if (!simulation.rowCount || simulation.rows[0].expires_at <= new Date())
          throw new ApiError(409, "simulation_expired", "The simulation is missing or expired.");
        const expectedDigest = agentActionDigest(c.agent_id, Number(row.version), normalizedAction);
        if (
          simulation.rows[0].policy_version !== Number(row.version) ||
          simulation.rows[0].action_digest !== expectedDigest
        )
          throw new ApiError(
            409,
            "simulation_mismatch",
            "The action no longer matches its simulation and policy version.",
          );
        boundSimulationId = simulation.rows[0].id;
        boundDigest = simulation.rows[0].action_digest;
      }
      const reasons: string[] = [];
      if (row.status !== "active") reasons.push(`account_${row.status}`);
      if (row.allowed_actions.length && !row.allowed_actions.includes(input.action))
        reasons.push("action_not_allowed");
      if (
        input.asset &&
        row.allowed_assets.length &&
        !row.allowed_assets.includes(input.asset.toLowerCase())
      )
        reasons.push("asset_not_allowed");
      if (
        input.venue &&
        row.allowed_venues.length &&
        !row.allowed_venues.includes(input.venue.toLowerCase())
      )
        reasons.push("venue_not_allowed");
      if (
        input.counterparty &&
        row.approved_counterparties.length &&
        !row.approved_counterparties.includes(input.counterparty.toLowerCase())
      )
        reasons.push("counterparty_not_allowed");
      const limits = await client.query<{
        action_exceeded: boolean;
        daily_exceeded: boolean;
        monthly_exceeded: boolean;
      }>(
        `SELECT
           ($2::numeric IS NOT NULL AND p.max_action_amount IS NOT NULL AND $2::numeric > p.max_action_amount) AS action_exceeded,
           ($2::numeric IS NOT NULL AND p.daily_budget IS NOT NULL AND
             COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
               AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('day', now())), 0) + $2::numeric > p.daily_budget) AS daily_exceeded,
           ($2::numeric IS NOT NULL AND p.monthly_budget IS NOT NULL AND
             COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
               AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('month', now())), 0) + $2::numeric > p.monthly_budget) AS monthly_exceeded
         FROM agent_account_policies p WHERE p.agent_id=$1`,
        [c.agent_id, input.amount ?? null],
      );
      if (limits.rows[0]?.action_exceeded) reasons.push("action_limit_exceeded");
      if (limits.rows[0]?.daily_exceeded) reasons.push("daily_budget_exceeded");
      if (limits.rows[0]?.monthly_exceeded) reasons.push("monthly_budget_exceeded");
      const ownerRules = ownerRuleReasons(row, input.amount ?? null);
      reasons.push(...ownerRules.denied, ...ownerRules.review);
      if (row.simulation_required && !boundDigest && !input.simulationDigest && !input.simulate)
        reasons.push("simulation_required");
      const reviewReasons = new Set(["simulation_required", "human_approval_required"]);
      const hardReasons = reasons.filter((reason) => !reviewReasons.has(reason));
      const decision = input.simulate
        ? "simulation"
        : hardReasons.length
          ? "denied"
          : reasons.length || row.approval_mode === "always"
            ? "approval_required"
            : "approved";
      const recorded = await client.query(
        "INSERT INTO agent_account_actions (agent_id,action,amount,asset,venue,counterparty,decision,reasons,policy_version,simulation_digest,simulation_id,normalized_action,receipt_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (simulation_id) DO NOTHING RETURNING id,created_at",
        [
          c.agent_id,
          input.action,
          input.amount ?? null,
          input.asset?.toLowerCase() ?? null,
          input.venue?.toLowerCase() ?? null,
          input.counterparty?.toLowerCase() ?? null,
          decision,
          reasons,
          row.version,
          boundDigest ?? input.simulationDigest ?? null,
          boundSimulationId,
          JSON.stringify(normalizedAction),
          boundDigest,
        ],
      );
      if (!recorded.rowCount)
        throw new ApiError(
          409,
          "simulation_already_authorized",
          "This simulation has already been authorized.",
        );
      await audit(client, {
        actorId: c.user_id,
        action: "agent_account.action_authorized_mcp",
        targetType: "agent_account_action",
        targetId: recorded.rows[0].id,
        requestId: request.requestId,
        metadata: { agentId: c.agent_id, decision, action: input.action },
      });
      await client.query("COMMIT");
      response.json({
        data: {
          actionId: recorded.rows[0].id,
          accountId: c.agent_id,
          decision,
          reasons,
          policyVersion: row.version,
          simulationDigest: boundDigest ?? input.simulationDigest ?? null,
          createdAt: recorded.rows[0].created_at,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

mcpInternalRouter.get(
  "/account/mandates",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const result = await db.query(
      "SELECT id,agent_id,parent_mandate_id,nonce,digest,payload,signature,status,expires_at,created_at FROM agent_mandates WHERE agent_id=$1 AND status='active' AND expires_at > now() ORDER BY created_at DESC",
      [c.agent_id],
    );
    response.json({ data: result.rows });
  }),
);

mcpInternalRouter.get(
  "/services",
  asyncRoute(async (request, response) => {
    await connection(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    const cursor = parseCursor(query.cursor);
    const result = await db.query(
      `SELECT s.id, s.agent_id, s.slug, s.name, s.description, s.service_type, s.execution_mode,
        s.price_usd, s.sla_minutes, s.requirements_schema, s.deliverable_schema, a.name AS agent_name
       FROM commerce_services s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.active = true AND ($1::timestamptz IS NULL OR (s.created_at,s.id) < ($1::timestamptz,$2::uuid))
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $3`,
      [cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const rows = result.rows.slice(0, query.limit);
    response.json({
      data: rows,
      nextCursor:
        result.rows.length > query.limit ? cursorFor(rows.at(-1).created_at, rows.at(-1).id) : null,
    });
  }),
);
