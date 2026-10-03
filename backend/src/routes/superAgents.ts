import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { encryptPayload } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

export const superAgentsRouter = Router();

const textInput = z.object({ text: z.string().trim().min(1).max(10_000) });
const decisionInput = z.object({ decision: z.enum(["approved", "rejected"]) });
const claimInput = z.object({ claimToken: z.string().min(24).max(200) });
const intentShape = z.object({
  agentName: z.string().trim().max(80).nullable().default(null),
  request: z.string().trim().min(1).max(10_000),
  budgetUsdg: z.number().finite().positive().nullable().default(null),
  deadlineAt: z.string().trim().max(80).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

const stateHash = (value: string) => createHash("sha256").update(value).digest("hex");
const oauthContext = (userId: string) => `superagent:x:${userId}`;

export function fallbackSuperAgentIntent(text: string) {
  const budget = text.match(/(?:budget|for)\s*[$]?([0-9]+(?:\.[0-9]+)?)\s*(?:USDG|USD)?/i);
  const hire = text.match(
    /(?:hire|assign|ask)\s+([A-Za-z][A-Za-z0-9 -]{1,60}?)(?:\s+to\b|\s+for\b|[,.:]|$)/i,
  );
  return intentShape.parse({
    agentName: hire?.[1]?.trim() ?? null,
    request: text.replace(/^\s*@\S+\s*/u, "").trim(),
    budgetUsdg: budget ? Number(budget[1]) : null,
    confidence: budget || hire ? 0.65 : 0.35,
  });
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
            "Extract a Liege Super Agent request. Return JSON only with agentName (string or null), request (string), budgetUsdg (number or null), deadlineAt (string or null), confidence (0..1). Never invent a budget, deadline, or agent.",
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
    return intentShape.parse(JSON.parse(content));
  } catch {
    return fallbackSuperAgentIntent(text);
  }
}

async function findAgent(agentName: string | null) {
  if (!agentName) return null;
  const result = await db.query<{ id: string; name: string; slug: string; category: string }>(
    `SELECT id, name, slug, category FROM agents WHERE active
     AND (name ILIKE $1 OR slug ILIKE $2 OR category ILIKE $1 OR capabilities::text ILIKE $3)
     ORDER BY created_at ASC LIMIT 1`,
    [
      `%${agentName}%`,
      `%${agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}%`,
      `%${agentName}%`,
    ],
  );
  return result.rows[0] ?? null;
}

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
      data: { authorizationUrl: `https://twitter.com/i/oauth2/authorize?${params}`, expiresAt },
    });
  }),
);

export const xCallback = asyncRoute(async (request, response) => {
  const state = z.string().min(16).parse(request.query.state);
  const code = z.string().min(1).parse(request.query.code);
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
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: env.X_CLIENT_ID,
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
    scope?: string[];
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
        tokens.scope ?? [],
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
      tokens.scope ?? [],
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
  requireAuth,
  asyncRoute(async (request, response) => {
    const userId = request.auth!.userId;
    const [identity, intents, jobs, agents] = await Promise.all([
      db.query(
        `SELECT x_user_id, x_username, scopes, connected_at, updated_at FROM superagent_x_identities WHERE user_id=$1`,
        [userId],
      ),
      db.query(
        `SELECT i.id,i.raw_text,i.parsed,i.status,i.expires_at,i.created_at,i.decided_at,a.id AS agent_id,a.name AS agent_name,a.slug AS agent_slug FROM superagent_intents i LEFT JOIN agents a ON a.id=i.agent_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT j.id,j.public_id,j.title,j.status,j.budget_usdg,j.deadline_at,j.created_at,a.name AS agent_name FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE j.client_id=$1 OR a.owner_id=$1 ORDER BY j.created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT id,slug,name,description,category,capabilities,reputation_score FROM agents WHERE active ORDER BY created_at ASC LIMIT 50`,
      ),
    ]);
    response.json({
      data: {
        identity: identity.rows[0] ?? null,
        proposals: intents.rows,
        jobs: jobs.rows,
        agents: agents.rows,
      },
    });
  }),
);

superAgentsRouter.post(
  "/intents/parse",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = textInput.parse(request.body);
    response.json({ data: await parseSuperAgentIntent(input.text) });
  }),
);

superAgentsRouter.post(
  "/intents",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = textInput.parse(request.body);
    const parsed = await parseSuperAgentIntent(input.text);
    const agent = await findAgent(parsed.agentName);
    const result = await db.query(
      `INSERT INTO superagent_intents (user_id,raw_text,parsed,agent_id,status,source) VALUES ($1,$2,$3,$4,$5,'dashboard') RETURNING id,raw_text,parsed,agent_id,status,expires_at,created_at`,
      [
        request.auth!.userId,
        input.text,
        parsed,
        agent?.id ?? null,
        agent ? "pending" : "unmatched",
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "superagent.intent_created",
      targetType: "superagent_intent",
      targetId: result.rows[0].id,
      requestId: request.requestId,
      metadata: { source: "dashboard", matched: Boolean(agent) },
    });
    response.status(201).json({ data: { ...result.rows[0], agent: agent ?? null } });
  }),
);

superAgentsRouter.get(
  "/intents",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT i.id,i.raw_text,i.parsed,i.status,i.expires_at,i.created_at,i.decided_at,a.id AS agent_id,a.name AS agent_name FROM superagent_intents i LEFT JOIN agents a ON a.id=i.agent_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

superAgentsRouter.post(
  "/intents/:id/decision",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const { decision } = decisionInput.parse(request.body);
    const result = await db.query(
      `UPDATE superagent_intents SET status=$3,decided_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at > now() RETURNING id,status,decided_at`,
      [id, request.auth!.userId, decision],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        "proposal_unavailable",
        "This Super Agent proposal is no longer available.",
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: `superagent.intent_${decision}`,
      targetType: "superagent_intent",
      targetId: id,
      requestId: request.requestId,
    });
    response.json({ data: result.rows[0] });
  }),
);
