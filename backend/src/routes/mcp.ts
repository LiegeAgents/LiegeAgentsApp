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
  asyncRoute(async (request, response) => response.json({ data: await connection(request) })),
);
mcpInternalRouter.get(
  "/jobs",
  asyncRoute(async (request, response) => {
    const c = await connection(request);
    const jobs = await db.query(
      "SELECT id, public_id, title, status, budget_usdg, deadline_at, expires_at, created_at FROM jobs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100",
      [c.agent_id],
    );
    response.json({ data: jobs.rows });
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
