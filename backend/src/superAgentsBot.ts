import { parseSuperAgentIntent } from "./routes/superAgents.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { audit } from "./audit.js";
import { findEnrolledAgent } from "./superAgentEnrollment.js";
import { decryptPayload, encryptPayload, payloadContext } from "./crypto.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let accessToken = env.X_ACCESS_TOKEN;
let refreshToken = env.X_REFRESH_TOKEN;
let credentialsLoaded = false;

async function ensureBotCredentials() {
  if (credentialsLoaded) return;
  try {
    const stored = await db.query<{
      access_token_ciphertext: string;
      refresh_token_ciphertext: string | null;
    }>(
      "SELECT access_token_ciphertext,refresh_token_ciphertext FROM superagent_x_bot_credentials WHERE id=true",
    );
    if (stored.rowCount) {
      accessToken = decryptPayload(
        stored.rows[0].access_token_ciphertext,
        payloadContext("superagent-x-bot", "access-token"),
      );
      refreshToken = stored.rows[0].refresh_token_ciphertext
        ? decryptPayload(
            stored.rows[0].refresh_token_ciphertext,
            payloadContext("superagent-x-bot", "refresh-token"),
          )
        : undefined;
    } else if (env.X_ACCESS_TOKEN) {
      await db.query(
        `INSERT INTO superagent_x_bot_credentials (id,access_token_ciphertext,refresh_token_ciphertext)
         VALUES (true,$1,$2) ON CONFLICT (id) DO NOTHING`,
        [
          encryptPayload(env.X_ACCESS_TOKEN, payloadContext("superagent-x-bot", "access-token")),
          env.X_REFRESH_TOKEN
            ? encryptPayload(
                env.X_REFRESH_TOKEN,
                payloadContext("superagent-x-bot", "refresh-token"),
              )
            : null,
        ],
      );
    }
  } catch (error) {
    // A migration can be applied after the process starts; env credentials still allow polling.
    console.error(
      "Super Agents X credential store unavailable:",
      error instanceof Error ? error.message : error,
    );
  }
  credentialsLoaded = true;
}

async function refreshXAccessToken() {
  if (!env.X_CLIENT_ID || !refreshToken) return false;
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
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      client_id: env.X_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!payload.access_token) return false;
  accessToken = payload.access_token;
  refreshToken = payload.refresh_token || refreshToken;
  try {
    await db.query(
      `UPDATE superagent_x_bot_credentials SET access_token_ciphertext=$1,refresh_token_ciphertext=$2,updated_at=now() WHERE id=true`,
      [
        encryptPayload(accessToken, payloadContext("superagent-x-bot", "access-token")),
        refreshToken
          ? encryptPayload(refreshToken, payloadContext("superagent-x-bot", "refresh-token"))
          : null,
      ],
    );
  } catch (error) {
    console.error(
      "Super Agents X credential persistence failed:",
      error instanceof Error ? error.message : error,
    );
  }
  return true;
}

async function xFetch(path: string, init: RequestInit = {}, retry = true) {
  const response = await fetch(`https://api.x.com${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 && retry && (await refreshXAccessToken()))
    return xFetch(path, init, false);
  if (!response.ok) throw new Error(`X API returned ${response.status}.`);
  return response.json() as Promise<any>;
}

async function replyToMention(tweetId: string, text: string) {
  await xFetch("/2/tweets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 280), reply: { in_reply_to_tweet_id: tweetId } }),
  });
}

async function pollMentions() {
  if (running || env.X_BOT_ENABLED !== "true" || !env.X_ACCESS_TOKEN || !env.X_BOT_HANDLE) return;
  running = true;
  try {
    await ensureBotCredentials();
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
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO superagent_intents (user_id,x_post_id,x_author_id,raw_text,parsed,agent_id,status,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'x') ON CONFLICT (x_post_id) DO NOTHING RETURNING id`,
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
      if (inserted.rowCount) {
        const link = `${env.SUPERAGENTS_URL.replace(/\/$/, "")}/auth`;
        const reply = userId
          ? matched
            ? `Got it — ${matched.name} is matched. Review the proposal in your Super Agents workspace: ${link}`
            : `I couldn't find an enabled Super Agent for that request. Browse available agents and get started: ${link}`
          : `I couldn't create a proposal yet. Connect your Liege account to get started: ${link}`;
        try {
          await replyToMention(tweet.id, reply);
        } catch (error) {
          console.error(
            "Super Agents X reply failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
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
