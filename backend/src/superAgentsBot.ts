import { parseSuperAgentIntent } from "./routes/superAgents.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { audit } from "./audit.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function xFetch(path: string) {
  const response = await fetch(`https://api.x.com${path}`, {
    headers: { authorization: `Bearer ${env.X_ACCESS_TOKEN}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
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
      const agent = parsed.agentName
        ? await db.query<{ id: string }>(
            "SELECT id FROM agents WHERE active AND (name ILIKE $1 OR slug ILIKE $2) ORDER BY created_at ASC LIMIT 1",
            [
              `%${parsed.agentName}%`,
              `%${parsed.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}%`,
            ],
          )
        : { rows: [] as Array<{ id: string }> };
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
  void pollMentions();
  timer = setInterval(() => void pollMentions(), env.X_BOT_MENTIONS_POLL_INTERVAL_MS);
}

export function stopSuperAgentsBot() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
