import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { hashRuntimeToken, requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { decryptPayload, encryptPayload, payloadContext } from "../crypto.js";
import { probeTransport } from "../superAgentProbe.js";
import { findEnrolledAgent, readyEnrollment } from "../superAgentEnrollment.js";
import { openSuperAgentJob } from "../superAgentSchedules.js";
import { latestProgressColumn } from "../jobProgress.js";
import { quoteIntent } from "../superAgentQuotes.js";
import { registerScheduleRoutes } from "./superAgentSchedules.js";
import { registerWatchlistRoutes } from "./superAgentWatchlist.js";
import { MAX_COUNTERS, counterProposal, type CounterRound } from "../superAgentCounters.js";
import { registerSquadRoutes } from "./superAgentSquads.js";
import { registerAuctionRoutes } from "./superAgentAuctions.js";
import { registerTriggerRoutes } from "./githubTriggers.js";
import { registerChainTriggerRoutes } from "./chainTriggers.js";
import { registerCallRoutes } from "./superAgentCalls.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { agentStanding } from "../reputation.js";

export const superAgentsRouter = Router();

const textInput = z.object({ text: z.string().trim().min(1).max(10_000) });
const intentInput = textInput.extend({
  source: z.enum(["dashboard", "cli"]).default("dashboard"),
  // Accepting a quote's suggested budget (or typing one) without restating it in the text.
  budgetAmount: z.number().finite().positive().optional(),
});
const decisionInput = z.object({ decision: z.enum(["approved", "rejected"]) });
const claimInput = z.object({ claimToken: z.string().min(24).max(200) });
const intentShape = z.object({
  agentName: z.string().trim().max(80).nullable().default(null),
  request: z.string().trim().min(1).max(10_000),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  budgetAmount: z.number().finite().positive().nullable().default(null),
  // Kept for compatibility with existing dashboard clients and stored intents.
  budgetUsdg: z.number().finite().positive().nullable().default(null),
  deadlineAt: z.string().trim().max(80).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

const counterInput = z.object({ budgetAmount: z.number().finite().positive() });

const intentAmount = (parsed: z.infer<typeof intentShape>) =>
  parsed.budgetAmount ?? parsed.budgetUsdg;

const normalizeIntent = (parsed: z.infer<typeof intentShape>) => ({
  ...parsed,
  budgetUsdg:
    parsed.settlementAsset === "usdg"
      ? (parsed.budgetUsdg ?? parsed.budgetAmount)
      : parsed.budgetUsdg,
});

const stateHash = (value: string) => createHash("sha256").update(value).digest("hex");
const oauthContext = (userId: string) => `superagent:x:${userId}`;
const xTokenHeaders = () => ({
  "content-type": "application/x-www-form-urlencoded",
  ...(env.X_CLIENT_ID && env.X_CLIENT_SECRET
    ? {
        authorization: `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString("base64")}`,
      }
    : {}),
});

export function fallbackSuperAgentIntent(text: string) {
  const budget = text.match(/(?:budget|for)\s*[$]?([0-9]+(?:\.[0-9]+)?)\s*(USDG|LIEGE|USD)?/i);
  const hire = text.match(
    /(?:hire|assign|ask)\s+([A-Za-z][A-Za-z0-9 -]{1,60}?)(?:\s+to\b|\s+for\b|[,.:]|$)/i,
  );
  return normalizeIntent(
    intentShape.parse({
      agentName: hire?.[1]?.trim() ?? null,
      request: text.replace(/^\s*@\S+\s*/u, "").trim(),
      settlementAsset: budget?.[2]?.toLowerCase() === "liege" ? "liege" : "usdg",
      budgetAmount: budget ? Number(budget[1]) : null,
      budgetUsdg: budget?.[2]?.toLowerCase() === "liege" ? null : budget ? Number(budget[1]) : null,
      confidence: budget || hire ? 0.65 : 0.35,
    }),
  );
}

export async function parseSuperAgentIntent(text: string) {
  if (!env.GROQ_API_KEY) return fallbackSuperAgentIntent(text);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract a Liege Super Agent request. Return JSON only with agentName (string or null), request (string), settlementAsset (usdg or liege, default usdg), budgetAmount (number or null), budgetUsdg (number or null for compatibility), deadlineAt (string or null), confidence (0..1). Never invent a budget, deadline, or agent. USDG and LIEGE are independent tokens; never convert between them.",
        },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return fallbackSuperAgentIntent(text);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) return fallbackSuperAgentIntent(text);
  try {
    return normalizeIntent(intentShape.parse(JSON.parse(content)));
  } catch {
    return fallbackSuperAgentIntent(text);
  }
}

async function findAgent(agentName: string | null) {
  return findEnrolledAgent(agentName);
}

superAgentsRouter.get(
  "/enrollments",
  requireAuth,
  asyncRoute(async (request, response) => {
    const owner = request.auth!.userId;
    const [agents, services, webhooks] = await Promise.all([
      db.query(
        `SELECT a.id,a.name,a.active,a.settlement_assets,e.service_id,e.webhook_id,e.settlement_assets AS enrollment_settlement_assets,e.enabled,e.verified_at,e.call_price_usdg,e.call_price_liege
      FROM agents a LEFT JOIN superagent_enrollments e ON e.agent_id=a.id WHERE a.owner_id=$1 ORDER BY a.created_at`,
        [owner],
      ),
      db.query(
        `SELECT s.id,s.agent_id,s.name,s.price_usd,s.sla_minutes,s.settlement_assets FROM commerce_services s JOIN agents a ON a.id=s.agent_id WHERE a.owner_id=$1 AND s.active`,
        [owner],
      ),
      db.query(
        `SELECT id,agent_id,url FROM webhook_subscriptions WHERE owner_id=$1 AND active AND 'job.funded'=ANY(event_types)`,
        [owner],
      ),
    ]);
    response.json({
      data: { agents: agents.rows, services: services.rows, webhooks: webhooks.rows },
    });
  }),
);

// Runtime credentials are separate from seven-day dashboard sessions. They are scoped to
// the owner's enrolled agents and can be rotated without changing enrollment or webhooks.
superAgentsRouter.post(
  "/runtime-token",
  requireAuth,
  asyncRoute(async (request, response) => {
    const token = randomBytes(32).toString("base64url");
    const enrolled = await db.query<{ id: string }>(
      `SELECT e.agent_id AS id FROM superagent_enrollments e
       JOIN agents a ON a.id=e.agent_id
       WHERE a.owner_id=$1 AND a.active AND e.enabled`,
      [request.auth!.userId],
    );
    if (!enrolled.rowCount)
      throw new ApiError(
        409,
        "no_enabled_super_agents",
        "Enable at least one Super Agent before creating a runtime token.",
      );
    const result = await db.query(
      `INSERT INTO runtime_tokens (owner_id,token_hash,agent_ids)
       VALUES ($1,$2,$3::uuid[]) RETURNING id,agent_ids,scopes,created_at`,
      [request.auth!.userId, hashRuntimeToken(token), enrolled.rows.map((row) => row.id)],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.runtime_token_created",
      targetType: "runtime_token",
      targetId: result.rows[0].id,
      requestId: request.requestId,
      metadata: { agentIds: result.rows[0].agent_ids, scopes: result.rows[0].scopes },
    });
    response.status(201).json({ data: { token, ...result.rows[0] } });
  }),
);

superAgentsRouter.get(
  "/runtime-tokens",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT id,agent_ids,scopes,created_at,last_used_at,revoked_at
       FROM runtime_tokens WHERE owner_id=$1 ORDER BY created_at DESC`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

superAgentsRouter.delete(
  "/runtime-tokens/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const tokenId = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `UPDATE runtime_tokens SET revoked_at=COALESCE(revoked_at,now())
       WHERE id=$1 AND owner_id=$2 RETURNING id,revoked_at`,
      [tokenId, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "runtime_token_not_found", "Runtime token not found.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.runtime_token_revoked",
      targetType: "runtime_token",
      targetId: tokenId,
      requestId: request.requestId,
    });
    response.json({ data: result.rows[0] });
  }),
);

superAgentsRouter.post(
  "/enrollments",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        agentId: z.string().uuid(),
        serviceId: z.string().uuid(),
        webhookId: z.string().uuid(),
        settlementAssets: z
          .array(z.enum(["usdg", "liege"]))
          .min(1)
          .default(["usdg"]),
      })
      .parse(request.body);
    const result = await db.query(
      `INSERT INTO superagent_enrollments (agent_id,service_id,webhook_id,settlement_assets)
    SELECT a.id,s.id,w.id,$5::text[] FROM agents a JOIN commerce_services s ON s.agent_id=a.id
    JOIN webhook_subscriptions w ON w.agent_id=a.id AND w.owner_id=a.owner_id
    WHERE a.id=$1 AND a.owner_id=$2 AND a.active AND s.id=$3 AND s.active
      AND w.id=$4 AND w.active AND 'job.funded'=ANY(w.event_types)
      AND $5::text[] <@ COALESCE(a.settlement_assets, ARRAY['usdg']::text[])
      AND $5::text[] <@ COALESCE(s.settlement_assets, ARRAY['usdg']::text[])
    ON CONFLICT (agent_id) DO UPDATE SET service_id=EXCLUDED.service_id,webhook_id=EXCLUDED.webhook_id,
      settlement_assets=EXCLUDED.settlement_assets,
      enabled=false,verified_at=NULL,updated_at=now() RETURNING *`,
      [
        input.agentId,
        request.auth!.userId,
        input.serviceId,
        input.webhookId,
        input.settlementAssets,
      ],
    );
    if (!result.rowCount)
      throw new ApiError(
        422,
        "invalid_enrollment",
        "Select supported settlement assets, an active agent you own, its service, and its funded-job webhook.",
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.enrollment_saved",
      targetType: "agent",
      targetId: input.agentId,
      requestId: request.requestId,
    });
    response.status(201).json({ data: result.rows[0] });
  }),
);

superAgentsRouter.post(
  "/enrollments/:agentId/verify",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const result = await db.query(
      `SELECT w.id,w.url,w.secret_ciphertext,s.slug AS service_slug,e.updated_at::text AS revision FROM agents a ${readyEnrollment} WHERE a.id=$1 AND a.owner_id=$2 AND a.active`,
      [agentId, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(
        404,
        "enrollment_unavailable",
        "Save a valid enrollment before testing the connection.",
      );
    const row = result.rows[0];
    const challenge = randomBytes(32).toString("hex");
    const secret = decryptPayload(row.secret_ciphertext, payloadContext(row.id, "webhook-secret"));
    const body = JSON.stringify({
      id: randomUUID(),
      type: "superagent.connection_test",
      agentId,
      serviceSlug: row.service_slug,
      challenge,
    });
    try {
      const reply = await probeTransport.send(row.url, body, {
        "content-type": "application/json",
        "x-liege-event-id": JSON.parse(body).id,
        "x-liege-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      });
      const expected = createHmac("sha256", secret)
        .update(`superagent.connection_test:${agentId}:${challenge}`)
        .digest("hex");
      const proof = reply.proof;
      if (
        !reply.ok ||
        proof.length !== expected.length ||
        !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
      )
        throw new Error("Invalid proof");
    } catch {
      throw new ApiError(
        422,
        "connection_test_failed",
        "The runtime must verify the signed connection test and return the connection proof. Check its URL, agent ID, and webhook secret.",
      );
    }
    const updated = await db.query(
      `UPDATE superagent_enrollments SET verified_at=now() WHERE agent_id=$1 AND webhook_id=$2 AND updated_at=$3 RETURNING *`,
      [agentId, row.id, row.revision],
    );
    if (!updated.rowCount)
      throw new ApiError(
        409,
        "enrollment_changed",
        "Enrollment changed during the test. Test again.",
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.connection_verified",
      targetType: "agent",
      targetId: agentId,
      requestId: request.requestId,
    });
    response.json({ data: updated.rows[0] });
  }),
);

superAgentsRouter.post(
  "/enrollments/:agentId/discovery",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const result = await db.query(
      `UPDATE superagent_enrollments e SET enabled=$3,updated_at=now()
    FROM agents a WHERE e.agent_id=a.id AND a.id=$1 AND a.owner_id=$2
    AND (NOT $3 OR (a.active AND e.verified_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM commerce_services s WHERE s.id=e.service_id AND s.agent_id=a.id AND s.active)
      AND EXISTS(SELECT 1 FROM webhook_subscriptions w WHERE w.id=e.webhook_id AND w.agent_id=a.id AND w.owner_id=a.owner_id AND w.active AND 'job.funded'=ANY(w.event_types)))) RETURNING e.*`,
      [agentId, request.auth!.userId, enabled],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        "enrollment_not_ready",
        "An owned, active enrollment with a verified connection is required.",
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: enabled ? "superagent.discovery_enabled" : "superagent.discovery_disabled",
      targetType: "agent",
      targetId: agentId,
      requestId: request.requestId,
    });
    response.json({ data: result.rows[0] });
  }),
);

superAgentsRouter.get(
  "/auth/x/start",
  asyncRoute(async (request, response) => {
    if (!env.X_CLIENT_ID || !env.X_OAUTH_REDIRECT_URI)
      throw new ApiError(503, "x_auth_unavailable", "X authorization is not configured.");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await db.query(
      `INSERT INTO superagent_x_oauth_states (user_id, state_hash, code_verifier, expires_at) VALUES ($1,$2,$3,$4)`,
      [request.auth?.userId ?? null, stateHash(state), verifier, expiresAt],
    );
    const params = new URLSearchParams({
      response_type: "code",
      client_id: env.X_CLIENT_ID,
      redirect_uri: env.X_OAUTH_REDIRECT_URI,
      scope: "tweet.read users.read offline.access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    response.json({
      data: { authorizationUrl: `https://x.com/i/oauth2/authorize?${params}`, expiresAt },
    });
  }),
);

export const xCallback = asyncRoute(async (request, response) => {
  const oauthError = typeof request.query.error === "string" ? request.query.error : null;
  if (oauthError) {
    const description =
      typeof request.query.error_description === "string"
        ? request.query.error_description
        : oauthError;
    throw new ApiError(400, "x_authorization_denied", description);
  }
  if (typeof request.query.state !== "string" || request.query.state.length < 16)
    throw new ApiError(400, "x_oauth_state_missing", "X returned an invalid OAuth state.");
  if (typeof request.query.code !== "string" || request.query.code.length < 1)
    throw new ApiError(400, "x_oauth_code_missing", "X returned no authorization code.");
  const state = request.query.state;
  const code = request.query.code;
  const stateResult = await db.query<{ id: string; user_id: string | null; code_verifier: string }>(
    `UPDATE superagent_x_oauth_states SET consumed_at=now()
     WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING id, user_id, code_verifier`,
    [stateHash(state)],
  );
  if (!stateResult.rowCount)
    throw new ApiError(400, "invalid_x_oauth_state", "This X authorization has expired.");
  if (!env.X_CLIENT_ID || !env.X_OAUTH_REDIRECT_URI)
    throw new ApiError(503, "x_auth_unavailable", "X authorization is not configured.");
  const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: xTokenHeaders(),
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: env.X_OAUTH_REDIRECT_URI,
      code_verifier: stateResult.rows[0].code_verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok)
    throw new ApiError(502, "x_oauth_failed", "X did not complete authorization.");
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string[] | string;
  };
  if (!tokens.access_token)
    throw new ApiError(502, "x_oauth_failed", "X returned no access token.");
  const profileResponse = await fetch("https://api.x.com/2/users/me?user.fields=username", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) throw new ApiError(502, "x_profile_failed", "X profile lookup failed.");
  const profile = (await profileResponse.json()) as { data?: { id: string; username?: string } };
  if (!profile.data?.id || !profile.data.username)
    throw new ApiError(502, "x_profile_failed", "X returned an incomplete profile.");
  const scopes = Array.isArray(tokens.scope)
    ? tokens.scope
    : typeof tokens.scope === "string"
      ? tokens.scope.split(/\s+/).filter(Boolean)
      : [];
  const userId = stateResult.rows[0].user_id;
  if (!userId) {
    const claimToken = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO superagent_x_claims (claim_hash,x_user_id,x_username,access_token_ciphertext,refresh_token_ciphertext,scopes,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        stateHash(claimToken),
        profile.data.id,
        profile.data.username,
        encryptPayload(tokens.access_token, "superagent:x:pending"),
        tokens.refresh_token ? encryptPayload(tokens.refresh_token, "superagent:x:pending") : null,
        scopes,
        new Date(Date.now() + 10 * 60_000),
      ],
    );
    response.redirect(
      `${env.SUPERAGENTS_URL.replace(/\/$/, "")}/auth?x=connected&claim=${claimToken}`,
    );
    return;
  }
  await db.query(
    `INSERT INTO superagent_x_identities (user_id,x_user_id,x_username,access_token_ciphertext,refresh_token_ciphertext,scopes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id) DO UPDATE SET x_user_id=EXCLUDED.x_user_id,x_username=EXCLUDED.x_username,
       access_token_ciphertext=EXCLUDED.access_token_ciphertext,refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
       scopes=EXCLUDED.scopes,updated_at=now()`,
    [
      userId,
      profile.data.id,
      profile.data.username,
      encryptPayload(tokens.access_token, oauthContext(userId)),
      tokens.refresh_token ? encryptPayload(tokens.refresh_token, oauthContext(userId)) : null,
      scopes,
    ],
  );
  await audit(db, {
    actorId: userId,
    action: "superagent.x_connected",
    targetType: "x_identity",
    targetId: profile.data.id,
    requestId: request.requestId,
    metadata: { username: profile.data.username },
  });
  response.redirect(`${env.SUPERAGENTS_URL.replace(/\/$/, "")}/auth?x=connected`);
});
superAgentsRouter.get("/auth/x/callback", xCallback);

superAgentsRouter.post(
  "/auth/x/claim",
  requireAuth,
  asyncRoute(async (request, response) => {
    const { claimToken } = claimInput.parse(request.body);
    const claim = await db.query<{
      x_user_id: string;
      x_username: string;
      access_token_ciphertext: string;
      refresh_token_ciphertext: string | null;
      scopes: string[];
    }>(
      `UPDATE superagent_x_claims SET claimed_at=now()
       WHERE claim_hash=$1 AND claimed_at IS NULL AND expires_at > now()
       RETURNING x_user_id,x_username,access_token_ciphertext,refresh_token_ciphertext,scopes`,
      [stateHash(claimToken)],
    );
    if (!claim.rowCount)
      throw new ApiError(400, "invalid_x_claim", "This X connection is expired or already linked.");
    const item = claim.rows[0];
    await db.query(
      `INSERT INTO superagent_x_identities (user_id,x_user_id,x_username,access_token_ciphertext,refresh_token_ciphertext,scopes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET x_user_id=EXCLUDED.x_user_id,x_username=EXCLUDED.x_username,
         access_token_ciphertext=EXCLUDED.access_token_ciphertext,refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
         scopes=EXCLUDED.scopes,updated_at=now()`,
      [
        request.auth!.userId,
        item.x_user_id,
        item.x_username,
        item.access_token_ciphertext,
        item.refresh_token_ciphertext,
        item.scopes,
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.x_connected",
      targetType: "x_identity",
      targetId: item.x_user_id,
      requestId: request.requestId,
      metadata: { username: item.x_username },
    });
    response.json({ data: { xUsername: item.x_username } });
  }),
);

superAgentsRouter.delete(
  "/auth/x",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "DELETE FROM superagent_x_identities WHERE user_id=$1 RETURNING x_user_id",
      [request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "x_identity_not_found", "No X identity is linked to this workspace.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.x_disconnected",
      targetType: "x_identity",
      targetId: result.rows[0].x_user_id,
      requestId: request.requestId,
    });
    response.status(204).end();
  }),
);

superAgentsRouter.get(
  "/dashboard",
  requireSessionOrMobileAuth("mobile:read"),
  asyncRoute(async (request, response) => {
    const userId = request.auth!.userId;
    const [identity, intents, jobs, agents] = await Promise.all([
      db.query(
        `SELECT x_user_id, x_username, scopes, connected_at, updated_at FROM superagent_x_identities WHERE user_id=$1`,
        [userId],
      ),
      db.query(
        `SELECT i.id,i.raw_text,i.parsed,i.negotiation,i.status,i.source,i.expires_at,i.created_at,i.decided_at,a.id AS agent_id,a.name AS agent_name,a.slug AS agent_slug,
           hk.name AS hire_key_name,j.id AS job_id,j.status AS job_status,${latestProgressColumn("j")}
         FROM superagent_intents i LEFT JOIN agents a ON a.id=i.agent_id
         LEFT JOIN hire_keys hk ON hk.id=i.hire_key_id
         LEFT JOIN jobs j ON j.client_id=i.user_id AND j.strategy_policy->>'intentId'=i.id::text
         WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT j.id,j.public_id,j.title,j.status,j.settlement_asset,j.budget_amount,j.budget_usdg,j.deadline_at,j.created_at,a.name AS agent_name,
           ${latestProgressColumn("j")}
         FROM jobs j JOIN agents a ON a.id=j.agent_id
         WHERE (j.client_id=$1 OR a.owner_id=$1) AND j.strategy_policy->>'source'='superagent'
         ORDER BY j.created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT a.id,a.slug,a.name,s.description,a.category,a.capabilities,a.settlement_assets,s.settlement_assets AS service_settlement_assets,a.reputation_score,s.price_usd,s.sla_minutes,e.call_price_usdg,e.call_price_liege FROM agents a ${readyEnrollment} WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL ORDER BY a.created_at ASC LIMIT 50`,
      ),
    ]);
    const standing = await agentStanding(agents.rows.map((agent) => agent.id));
    response.json({
      data: {
        identity: identity.rows[0] ?? null,
        proposals: intents.rows,
        jobs: jobs.rows,
        agents: agents.rows.map((agent) => ({
          ...agent,
          verified: standing.get(agent.id)?.verified ?? false,
          reputation: standing.get(agent.id)?.reputation ?? null,
        })),
      },
    });
  }),
);

/**
 * Creates a pending Super Agent proposal from a request (and an optional budget), as the
 * dashboard, CLI, and hiring keys do. `cap` limits the budget a hiring key may propose.
 */
export async function createIntent(
  userId: string,
  requestId: string | undefined,
  input: {
    text: string;
    source: "dashboard" | "cli" | "mcp";
    budgetAmount?: number;
    // Names the agent when the caller already chose one, as an agent's own A2A endpoint does.
    agentName?: string;
    // Without a budget, propose the quote's suggested budget (the listed USDG price).
    suggestBudget?: boolean;
    hireKeyId?: string;
    cap?: (budget: number, asset: "usdg" | "liege") => Promise<void>;
  },
) {
  const parsedRequest = await parseSuperAgentIntent(input.text);
  const parsedText = input.agentName
    ? { ...parsedRequest, agentName: input.agentName }
    : parsedRequest;
  let parsed =
    input.budgetAmount === undefined
      ? parsedText
      : {
          ...parsedText,
          budgetAmount: input.budgetAmount,
          budgetUsdg: parsedText.settlementAsset === "usdg" ? input.budgetAmount : null,
        };
  const asset = parsed.settlementAsset;
  let budget = intentAmount(parsed);
  const agent = await findEnrolledAgent(parsed.agentName, asset);
  if (!agent)
    throw new ApiError(
      422,
      "agent_unavailable",
      parsed.agentName
        ? `${parsed.agentName} is not currently enrolled and discoverable as a Super Agent.`
        : "Include the name of an enrolled Super Agent.",
    );
  const suggested =
    !budget && input.suggestBudget ? (await quoteIntent(parsed))?.suggestedBudget : null;
  if (suggested) {
    parsed = { ...parsed, budgetAmount: suggested, budgetUsdg: suggested };
    budget = suggested;
  }
  if (!budget)
    throw new ApiError(
      422,
      "incomplete_proposal",
      `Include an available agent and a positive ${asset.toUpperCase()} budget to create a proposal.`,
    );
  await input.cap?.(budget, asset);
  const result = await db.query(
    `INSERT INTO superagent_intents (user_id,raw_text,parsed,agent_id,status,source,hire_key_id) VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id,raw_text,parsed,agent_id,status,expires_at,created_at`,
    [userId, input.text, parsed, agent.id, input.source, input.hireKeyId ?? null],
  );
  await audit(db, {
    actorId: userId,
    action: "superagent.intent_created",
    targetType: "superagent_intent",
    targetId: result.rows[0].id,
    requestId,
    metadata: { source: input.source, matched: true },
  });
  return { ...result.rows[0], agent, quote: await quoteIntent(parsed) };
}

superAgentsRouter.post(
  "/intents/parse",
  requireSessionOrMobileAuth("mobile:read"),
  asyncRoute(async (request, response) => {
    const input = textInput.parse(request.body);
    const parsed = await parseSuperAgentIntent(input.text);
    response.json({ data: { ...parsed, quote: await quoteIntent(parsed) } });
  }),
);

superAgentsRouter.post(
  "/intents",
  requireSessionOrMobileAuth("mobile:approve"),
  asyncRoute(async (request, response) => {
    const input = intentInput.parse(request.body);
    response.status(201).json({
      data: await createIntent(request.auth!.userId, request.requestId, input),
    });
  }),
);

superAgentsRouter.get(
  "/intents",
  requireSessionOrMobileAuth("mobile:read"),
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT i.id,i.raw_text,i.parsed,i.negotiation,i.status,i.source,i.expires_at,i.created_at,i.decided_at,a.id AS agent_id,a.name AS agent_name,hk.name AS hire_key_name,j.id AS job_id,j.status AS job_status,
       ${latestProgressColumn("j")}
       FROM superagent_intents i LEFT JOIN agents a ON a.id=i.agent_id
       LEFT JOIN hire_keys hk ON hk.id=i.hire_key_id
       LEFT JOIN jobs j ON j.client_id=i.user_id AND j.strategy_policy->>'intentId'=i.id::text
       WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

/**
 * Counters a pending proposal's budget; the agent's rule answers at once. A hiring key counters
 * only its own proposals, and `cap` refuses agreed budgets above its limits.
 */
export async function counterIntent(
  userId: string,
  requestId: string | undefined,
  id: string,
  budgetAmount: number,
  hireKeyId?: string,
  cap?: (agreed: number) => Promise<void>,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      parsed: unknown;
      agent_id: string | null;
      agent_name: string | null;
      negotiation: CounterRound[];
    }>(
      `SELECT i.parsed, i.agent_id, a.name AS agent_name, i.negotiation
         FROM superagent_intents i LEFT JOIN agents a ON a.id = i.agent_id
         WHERE i.id=$1 AND i.user_id=$2 AND i.status='pending' AND i.expires_at > now()
           AND ($3::uuid IS NULL OR i.hire_key_id = $3)
         FOR UPDATE OF i`,
      [id, userId, hireKeyId ?? null],
    );
    const intent = found.rows[0];
    if (!intent)
      throw new ApiError(
        409,
        "proposal_unavailable",
        "This Super Agent proposal is no longer available.",
      );
    if (!intent.agent_id)
      throw new ApiError(
        422,
        "agent_unmatched",
        "Match this request to an active agent before countering it.",
      );
    const parsed = intentShape.parse(intent.parsed);
    const { round, negotiation } = await counterProposal(
      client,
      { agent_id: intent.agent_id, negotiation: intent.negotiation },
      parsed.settlementAsset,
      budgetAmount,
    );
    await cap?.(round.agreed);
    const terms = normalizeIntent({
      ...parsed,
      budgetAmount: round.agreed,
      budgetUsdg: round.agreed,
    });
    const updated = await client.query(
      `UPDATE superagent_intents SET parsed=$3, negotiation=$4 WHERE id=$1 AND user_id=$2
         RETURNING id, parsed, negotiation, status, expires_at`,
      [id, userId, terms, JSON.stringify(negotiation)],
    );
    await audit(client, {
      actorId: userId,
      action: "superagent.intent_countered",
      targetType: "superagent_intent",
      targetId: id,
      requestId,
      metadata: { offer: round.offer, outcome: round.outcome, agreed: round.agreed },
    });
    await client.query("COMMIT");
    const name = intent.agent_name ?? "The agent";
    const left = MAX_COUNTERS - negotiation.length;
    return {
      ...updated.rows[0],
      round,
      message:
        round.outcome === "accepted"
          ? `${name} accepts ${round.agreed} USDG. Approve the proposal to open the job.`
          : left > 0
            ? `${name} can do it for ${round.agreed} USDG. Approve at that price, or counter once more.`
            : `${round.agreed} USDG is ${name}'s best price. Approve it or dismiss the proposal.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The client counters a pending proposal's budget; the agent's rule answers at once.
superAgentsRouter.post(
  "/intents/:id/counter",
  requireSessionOrMobileAuth("mobile:approve"),
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const { budgetAmount } = counterInput.parse(request.body);
    response.json({
      data: await counterIntent(request.auth!.userId, request.requestId, id, budgetAmount),
    });
  }),
);

superAgentsRouter.post(
  "/intents/:id/decision",
  requireSessionOrMobileAuth("mobile:approve"),
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const { decision } = decisionInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const intent = await client.query<{
        id: string;
        parsed: unknown;
        agent_id: string | null;
        status: string;
      }>(
        `SELECT id, parsed, agent_id, status FROM superagent_intents
         WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at > now()
         FOR UPDATE`,
        [id, request.auth!.userId],
      );
      if (!intent.rowCount)
        throw new ApiError(
          409,
          "proposal_unavailable",
          "This Super Agent proposal is no longer available.",
        );

      let job: Record<string, unknown> | null = null;
      if (decision === "approved") {
        if (!intent.rows[0].agent_id)
          throw new ApiError(
            422,
            "agent_unmatched",
            "Match this request to an active agent before approving it.",
          );
        const parsed = intentShape.parse(intent.rows[0].parsed);
        const budget = intentAmount(parsed);
        const asset = parsed.settlementAsset;
        if (!budget || budget <= 0)
          throw new ApiError(
            422,
            "budget_required",
            `Add a positive ${asset.toUpperCase()} budget before approving this request.`,
          );
        job = await openSuperAgentJob(client, {
          userId: request.auth!.userId,
          agentId: intent.rows[0].agent_id,
          asset,
          budget,
          request: parsed.request,
          deadlineAt: parsed.deadlineAt,
          policy: { intentId: id },
        });
      }
      const result = await client.query(
        `UPDATE superagent_intents SET status=$3,decided_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,status,decided_at`,
        [id, request.auth!.userId, decision],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: `superagent.intent_${decision}`,
        targetType: "superagent_intent",
        targetId: id,
        requestId: request.requestId,
        metadata: job ? { jobId: job.id } : undefined,
      });
      await client.query("COMMIT");
      response.json({ data: { ...result.rows[0], job } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

registerScheduleRoutes(superAgentsRouter);
registerWatchlistRoutes(superAgentsRouter);
registerSquadRoutes(superAgentsRouter);
registerAuctionRoutes(superAgentsRouter);
registerTriggerRoutes(superAgentsRouter);
registerChainTriggerRoutes(superAgentsRouter);
registerCallRoutes(superAgentsRouter);
