import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const codeInput = z.object({ code: z.string().min(1).max(500) });
const tokenDigest = (expiresAt: string) =>
  createHmac("sha256", env.MASTER_ADMIN_CODE ?? "")
    .update(`liege-admin:${expiresAt}`)
    .digest("base64url");

export function issueMasterAdminToken(now = Math.floor(Date.now() / 1000)) {
  const expiresAt = String(now + TOKEN_TTL_SECONDS);
  return `adm_${expiresAt}.${tokenDigest(expiresAt)}`;
}

function assertMasterAdmin(request: { header(name: string): string | undefined }) {
  const bearer = request.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer?.startsWith("adm_"))
    throw new ApiError(401, "admin_session_required", "A valid admin session is required.");
  const [rawExpiry, signature] = bearer.slice(4).split(".");
  const expiresAt = Number(rawExpiry);
  if (!signature || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))
    throw new ApiError(401, "admin_session_expired", "The admin session has expired.");
  const expected = Buffer.from(tokenDigest(rawExpiry));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ApiError(401, "admin_session_invalid", "The admin session is invalid.");
}

export const adminAccessRouter = Router();

adminAccessRouter.post(
  "/session",
  asyncRoute(async (request, response) => {
    if (!env.MASTER_ADMIN_CODE)
      throw new ApiError(503, "admin_not_configured", "Master admin access is not configured.");
    const input = codeInput.parse(request.body);
    const expected = createHmac("sha256", env.MASTER_ADMIN_CODE).update("login").digest();
    const actual = createHmac("sha256", input.code).update("login").digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new ApiError(401, "invalid_admin_code", "The master admin code is incorrect.");
    response.json({
      data: {
        token: issueMasterAdminToken(),
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      },
    });
  }),
);

adminAccessRouter.get(
  "/metrics",
  asyncRoute(async (request, response) => {
    assertMasterAdmin(request);
    const [
      users,
      agents,
      jobs,
      jobStatuses,
      jobAssets,
      enrollments,
      connections,
      evaluators,
      invoices,
    ] = await Promise.all([
      db.query<{ count: string }>("SELECT count(*)::int AS count FROM users"),
      db.query<{ total: string; active: string }>(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active FROM agents",
      ),
      db.query<{ count: string }>("SELECT count(*)::int AS count FROM jobs"),
      db.query<{ status: string; count: string }>(
        "SELECT status, count(*)::int AS count FROM jobs GROUP BY status ORDER BY status",
      ),
      db.query<{ asset: string; count: string }>(
        "SELECT COALESCE(settlement_asset, 'usdg') AS asset, count(*)::int AS count FROM jobs GROUP BY COALESCE(settlement_asset, 'usdg') ORDER BY asset",
      ),
      db.query<{ total: string; enabled: string }>(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled FROM superagent_enrollments",
      ),
      db.query<{ count: string }>(
        "SELECT count(*)::int AS count FROM mcp_connections WHERE revoked_at IS NULL AND expires_at > now()",
      ),
      db.query<{ count: string }>("SELECT count(*)::int AS count FROM evaluator_profiles"),
      db.query<{ count: string }>("SELECT count(*)::int AS count FROM invoices"),
    ]);
    response.json({
      data: {
        generatedAt: new Date().toISOString(),
        users: users.rows[0].count,
        agents: agents.rows[0],
        jobs: {
          total: jobs.rows[0].count,
          byStatus: jobStatuses.rows,
          bySettlementAsset: jobAssets.rows,
        },
        superAgents: enrollments.rows[0],
        activeMcpConnections: connections.rows[0].count,
        evaluators: evaluators.rows[0].count,
        invoices: invoices.rows[0].count,
      },
    });
  }),
);
