import { parseSuperAgentIntent } from "./routes/superAgents.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { audit } from "./audit.js";
import { findEnrolledAgent } from "./superAgentEnrollment.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let accessToken = env.X_ACCESS_TOKEN;

async function refreshXAccessToken() {
  if (!env.X_CLIENT_ID || !env.X_REFRESH_TOKEN) return false;
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(env.X_CLIENT_SECRET
        ? {
            authorization: `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString("base64")}`,
          }
        : {}),
    },
    body: new URLSearchParams({
      refresh_token: env.X_REFRESH_TOKEN,
      grant_type: "refresh_token",
      client_id: env.X_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) return false;
  accessToken = payload.access_token;
  return true;
}

async function xFetch(path: string, retry = true) {
  const response = await fetch(`https://api.x.com${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 && retry && (await refreshXAccessToken())) return xFetch(path, false);
  if (!response.ok) throw new Error(`X API returned ${response.status}.`);
  return response.json() as Promise<any>;
}

async function pollMentions() {
  if (running || env.X_BOT_ENABLED !== "true" || !env.X_ACCESS_TOKEN || !env.X_BOT_HANDLE) return;
  running = true;
  try {
    const profile = await xFetch(`/2/users/by/username/${encodeURIComponent(env.X_BOT_HANDLE)}`);
    const botId = profile?.data?.id;
    if (!botId) return;
    const cursor = await db.query<{ since_id: string | null }>(
      "SELECT since_id FROM superagent_x_cursor WHERE id=true",
    );
    const sinceId = cursor.rows[0]?.since_id;
    const params = new URLSearchParams({
      "tweet.fields": "author_id,created_at,conversation_id",
      expansions: "author_id",
      max_results: "100",
    });
    if (sinceId) params.set("since_id", sinceId);
    const payload = await xFetch(`/2/users/${botId}/mentions?${params}`);
    const tweets = [...(payload?.data ?? [])].reverse() as Array<{
      id: string;
      author_id?: string;
      text: string;
      created_at?: string;
    }>;
    for (const tweet of tweets) {
      const identity = await db.query<{ user_id: string }>(
        "SELECT user_id FROM superagent_x_identities WHERE x_user_id=$1",
        [tweet.author_id ?? ""],
      );
      const userId = identity.rows[0]?.user_id ?? null;
      const parsed = await parseSuperAgentIntent(tweet.text);
      const matched = await findEnrolledAgent(parsed.agentName);
      const agent = { rows: matched ? [matched] : [] };
      await db.query(
        `INSERT INTO superagent_intents (user_id,x_post_id,x_author_id,raw_text,parsed,agent_id,status,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'x') ON CONFLICT (x_post_id) DO NOTHING`,
        [
          userId,
          tweet.id,
          tweet.author_id ?? null,
          tweet.text,
          parsed,
          agent.rows[0]?.id ?? null,
          agent.rows[0]?.id ? "pending" : "unmatched",
        ],
      );
      if (userId)
        await audit(db, {
          actorId: userId,
          action: "superagent.x_intent_received",
          targetType: "x_post",
          targetId: tweet.id,
          requestId: tweet.id,
          metadata: { matched: Boolean(agent.rows[0]?.id) },
        });
    }
    if (payload?.meta?.newest_id)
      await db.query(
        `INSERT INTO superagent_x_cursor (id,since_id) VALUES (true,$1) ON CONFLICT (id) DO UPDATE SET since_id=EXCLUDED.since_id,updated_at=now()`,
        [payload.meta.newest_id],
      );
  } catch (error) {
    console.error("Super Agents X poll failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startSuperAgentsBot() {
  if (env.X_BOT_ENABLED !== "true") return;
  accessToken = env.X_ACCESS_TOKEN;
  void pollMentions();
  timer = setInterval(() => void pollMentions(), env.X_BOT_MENTIONS_POLL_INTERVAL_MS);
}

export function stopSuperAgentsBot() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
