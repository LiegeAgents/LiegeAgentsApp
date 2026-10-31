import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { latestProgressColumn } from "../jobProgress.js";
import { agentStanding } from "../reputation.js";
import { readyEnrollment } from "../superAgentEnrollment.js";
import { quoteIntent } from "../superAgentQuotes.js";
import { privatePayload } from "./jobs.js";
import { buildHarnessPresets, internalServiceToken } from "./mcp.js";
import { counterIntent, createIntent, parseSuperAgentIntent } from "./superAgents.js";

// A hiring key lets the client's own AI agent find, quote, propose, and counter Super Agent
// work over MCP. It never approves or funds: proposals wait in the client's Requests.

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const keyInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    maxBudgetPerHire: z.number().finite().positive(),
    dailyBudget: z.number().finite().positive(),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .refine((input) => input.dailyBudget >= input.maxBudgetPerHire, {
    message: "The daily budget must be at least the per-hire budget.",
    path: ["dailyBudget"],
  });
const textInput = z.object({ text: z.string().trim().min(1).max(10_000) });
const proposalInput = textInput.extend({ budgetAmount: z.number().finite().positive().optional() });
const counterInput = z.object({ budgetAmount: z.number().finite().positive() });

export type HireKey = {
  id: string;
  user_id: string;
  name: string;
  max_budget_per_hire: string;
  daily_budget: string;
};

// Proposals count against the daily budget while they are pending or once approved.
const countsToday = `created_at > now() - interval '24 hours'
  AND (status = 'approved' OR (status = 'pending' AND expires_at > now()))`;
const keyColumns = `k.id, k.name, k.max_budget_per_hire, k.daily_budget, k.expires_at, k.revoked_at,
  k.last_used_at, k.created_at,
  (SELECT COALESCE(SUM((parsed->>'budgetAmount')::numeric), 0) FROM superagent_intents
    WHERE hire_key_id = k.id AND ${countsToday}) AS proposed_today`;

async function hireKey(request: { header(name: string): string | undefined }) {
  if (!internalServiceToken(request.header("x-mcp-internal-token")))
    throw new ApiError(401, "invalid_mcp_service", "A valid MCP service token is required.");
  return hireKeyForToken(request.header("x-mcp-connection-token"));
}

/** Resolves an active hiring key from its `lmh_` token and records its use. */
export async function hireKeyForToken(token: string | undefined) {
  if (!token?.startsWith("lmh_"))
    throw new ApiError(401, "invalid_hire_key", "A Liege hiring key is required.");
  const result = await db.query<HireKey>(
    `UPDATE hire_keys SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, user_id, name, max_budget_per_hire, daily_budget`,
    [hash(token)],
  );
  if (!result.rowCount)
    throw new ApiError(401, "invalid_hire_key", "This hiring key is invalid, revoked, or expired.");
  return result.rows[0];
}

/** Refuses budgets above the key's limits. Caps bound what the key may propose, not what is paid. */
export async function withinCaps(key: HireKey, budget: number, asset: string, intentId?: string) {
  if (asset !== "usdg")
    throw new ApiError(422, "hire_key_usdg_only", "Hiring keys propose USDG budgets only.");
  const perHire = Number(key.max_budget_per_hire);
  if (budget > perHire)
    throw new ApiError(
      422,
      "hire_cap_exceeded",
      `This key can propose at most ${perHire} USDG per hire.`,
    );
  const spent = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM((parsed->>'budgetAmount')::numeric), 0) AS total FROM superagent_intents
     WHERE hire_key_id = $1 AND ${countsToday} AND ($2::uuid IS NULL OR id <> $2)`,
    [key.id, intentId ?? null],
  );
  const daily = Number(key.daily_budget);
  const left = daily - Number(spent.rows[0].total);
  if (budget > left)
    throw new ApiError(
      422,
      "hire_daily_cap_exceeded",
      `This key has ${Math.max(0, left)} of its ${daily} USDG daily budget left.`,
    );
}

export const pendingNote =
  "Waiting for the key owner's approval in Liege Super Agents → Requests. Nothing is paid until they approve and fund it.";

export const hireKeysRouter = Router();
hireKeysRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = keyInput.parse(request.body);
    const token = `lmh_${randomBytes(32).toString("hex")}`;
    const result = await db.query<{ id: string; expires_at: Date }>(
      `INSERT INTO hire_keys (user_id, name, token_hash, max_budget_per_hire, daily_budget, expires_at)
       VALUES ($1,$2,$3,$4,$5,now() + make_interval(days => $6)) RETURNING id, expires_at`,
      [
        request.auth!.userId,
        input.name,
        hash(token),
        input.maxBudgetPerHire,
        input.dailyBudget,
        input.expiresInDays,
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.hire_key_created",
      targetType: "hire_key",
      targetId: result.rows[0].id,
      requestId: request.requestId,
      metadata: { maxBudgetPerHire: input.maxBudgetPerHire, dailyBudget: input.dailyBudget },
    });
    response.status(201).json({
      data: {
        id: result.rows[0].id,
        token,
        expiresAt: result.rows[0].expires_at,
        presets: buildHarnessPresets({
          serverName: "liege-hire",
          serverUrl: `${(env.MCP_PUBLIC_URL || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`,
          token,
          agentName: input.name,
        }),
      },
    });
  }),
);
hireKeysRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT ${keyColumns} FROM hire_keys k WHERE k.user_id = $1 ORDER BY k.created_at DESC`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);
hireKeysRouter.delete(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "UPDATE hire_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "hire_key_not_found", "This hiring key is unavailable.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "mcp.hire_key_revoked",
      targetType: "hire_key",
      targetId: id,
      requestId: request.requestId,
    });
    response.status(204).end();
  }),
);

// Called only by the MCP service with its internal token and the client's hiring key.
export const hireRouter = Router();
hireRouter.get(
  "/session",
  asyncRoute(async (request, response) => {
    const key = await hireKey(request);
    const result = await db.query(`SELECT ${keyColumns} FROM hire_keys k WHERE k.id = $1`, [
      key.id,
    ]);
    response.json({ data: result.rows[0] });
  }),
);
/** Super Agents a hiring key can propose work to: discoverable, verified, and paid in USDG. */
export async function hireableAgents(slug?: string, asset: "usdg" | "liege" = "usdg") {
  const agents = await db.query(
    `SELECT a.id, a.slug, a.name, s.name AS service_name, s.description, a.category,
       a.capabilities, s.price_usd, s.sla_minutes, s.sample_request, s.sample_deliverable
     FROM agents a ${readyEnrollment}
     WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL AND $2 = ANY(e.settlement_assets)
       AND ($1::text IS NULL OR a.slug = $1)
     ORDER BY a.created_at ASC LIMIT 50`,
    [slug ?? null, asset],
  );
  const standing = await agentStanding(agents.rows.map((agent) => agent.id));
  return agents.rows.map((agent) => ({
    ...agent,
    verified: standing.get(agent.id)?.verified ?? false,
    reputation: standing.get(agent.id)?.reputation ?? null,
  }));
}

hireRouter.get(
  "/agents",
  asyncRoute(async (request, response) => {
    await hireKey(request);
    response.json({ data: await hireableAgents() });
  }),
);
hireRouter.post(
  "/quote",
  asyncRoute(async (request, response) => {
    await hireKey(request);
    const { text } = textInput.parse(request.body);
    const parsed = await parseSuperAgentIntent(text);
    response.json({ data: { ...parsed, quote: await quoteIntent(parsed) } });
  }),
);
hireRouter.post(
  "/proposals",
  asyncRoute(async (request, response) => {
    const key = await hireKey(request);
    const input = proposalInput.parse(request.body);
    const intent = await createIntent(key.user_id, request.requestId, {
      ...input,
      source: "mcp",
      hireKeyId: key.id,
      cap: (budget, asset) => withinCaps(key, budget, asset),
    });
    response.status(201).json({ data: { ...intent, note: pendingNote } });
  }),
);
hireRouter.post(
  "/proposals/:id/counter",
  asyncRoute(async (request, response) => {
    const key = await hireKey(request);
    const id = z.string().uuid().parse(request.params.id);
    const { budgetAmount } = counterInput.parse(request.body);
    const data = await counterIntent(
      key.user_id,
      request.requestId,
      id,
      budgetAmount,
      key.id,
      (agreed) => withinCaps(key, agreed, "usdg", id),
    );
    response.json({ data: { ...data, note: pendingNote } });
  }),
);
hireRouter.get(
  "/proposals",
  asyncRoute(async (request, response) => {
    const key = await hireKey(request);
    const result = await db.query(
      `SELECT i.id, i.raw_text, i.parsed, i.negotiation, i.status, i.expires_at, i.created_at,
         i.decided_at, a.name AS agent_name, a.slug AS agent_slug, j.id AS job_id,
         j.status AS job_status, ${latestProgressColumn("j")}
       FROM superagent_intents i LEFT JOIN agents a ON a.id = i.agent_id
       LEFT JOIN jobs j ON j.client_id = i.user_id AND j.strategy_policy->>'intentId' = i.id::text
       WHERE i.hire_key_id = $1 ORDER BY i.created_at DESC LIMIT 50`,
      [key.id],
    );
    response.json({ data: result.rows });
  }),
);
/** A key's proposal with its job, and the delivered work once the agent has submitted it. */
export async function hireOutcome(key: HireKey, id: string, requestId: string | undefined) {
  const found = await db.query<{
    status: string;
    expired: boolean;
    job_id: string | null;
    job_status: string | null;
    submitted_at: Date | null;
    progress: { message: string } | null;
  }>(
    `SELECT i.status, i.status = 'pending' AND i.expires_at <= now() AS expired, j.id AS job_id,
       j.status AS job_status, j.submitted_at, ${latestProgressColumn("j")}
     FROM superagent_intents i
     LEFT JOIN jobs j ON j.client_id = i.user_id AND j.strategy_policy->>'intentId' = i.id::text
     WHERE i.id = $1 AND i.hire_key_id = $2`,
    [id, key.id],
  );
  const row = found.rows[0];
  if (!row) throw new ApiError(404, "proposal_not_found", "This proposal is not from this key.");
  const base = {
    proposalStatus: row.expired ? "expired" : row.status,
    jobId: row.job_id,
    jobStatus: row.job_status,
    progress: row.progress,
  };
  if (!row.job_id || !row.submitted_at)
    return {
      ...base,
      deliverable: null,
      note:
        base.proposalStatus === "pending"
          ? pendingNote
          : row.job_id
            ? "The agent has not delivered yet."
            : "This proposal did not become a job.",
    };
  // Read through the client's audited payload access, like the dashboard does.
  const payload = await privatePayload(
    { auth: { userId: key.user_id }, requestId },
    row.job_id,
    "deliverable",
  );
  return { ...base, deliverable: payload.content, deliverableHash: payload.hash };
}

hireRouter.get(
  "/proposals/:id/result",
  asyncRoute(async (request, response) => {
    const key = await hireKey(request);
    const id = z.string().uuid().parse(request.params.id);
    const { progress: _progress, ...data } = await hireOutcome(key, id, request.requestId);
    response.json({ data });
  }),
);
