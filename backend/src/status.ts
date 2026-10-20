import { db } from "./db/index.js";
import { readyEnrollment } from "./superAgentEnrollment.js";
import { assertSafeWebhookUrl } from "./webhooks.js";

export type AgentStatus = "online" | "offline" | "unreported";

/** Tests replace the runtime transport; production reads each runtime's public /health. */
export const statusTransport = {
  async health(url: string): Promise<{ ok: boolean; body: unknown }> {
    await assertSafeWebhookUrl(url);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, body: null };
    const text = await response.text();
    return { ok: true, body: text.length <= 65_536 ? JSON.parse(text) : null };
  },
};

const CACHE_MS = 60_000;
let cached: { at: number; value: Promise<Awaited<ReturnType<typeof checkStatus>>> } | null = null;

/**
 * Whether the API and database answer, and which verified Super Agents their runtime reports as
 * loaded. A runtime that answers without listing its agents is "unreported", never "online".
 */
async function checkStatus(commit: string | undefined) {
  const checkedAt = new Date().toISOString();
  let agents: Array<{ name: string; slug: string; category: string; url: string }> = [];
  let database: "ok" | "unavailable" = "ok";
  try {
    agents = (
      await db.query(
        `SELECT a.name, a.slug, a.category, w.url FROM agents a ${readyEnrollment}
         LEFT JOIN agent_accounts acc ON acc.agent_id = a.id
         WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL
           AND COALESCE(acc.status, 'active') = 'active'
         ORDER BY a.name`,
      )
    ).rows;
  } catch {
    database = "unavailable";
  }
  // One health check per runtime, however many agents it serves.
  const origins = [...new Set(agents.map((agent) => new URL(agent.url).origin))];
  const runtimes = new Map(
    await Promise.all(
      origins.map(async (origin) => {
        try {
          const { ok, body } = await statusTransport.health(`${origin}/health`);
          const listed = (body as { data?: { agents?: unknown } } | null)?.data?.agents;
          return [
            origin,
            { ok, agents: Array.isArray(listed) ? listed.map(String) : null },
          ] as const;
        } catch {
          return [origin, { ok: false, agents: null }] as const;
        }
      }),
    ),
  );
  const superAgents = agents.map((agent) => {
    const url = new URL(agent.url);
    const runtime = runtimes.get(url.origin);
    const key = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const status: AgentStatus = !runtime?.ok
      ? "offline"
      : runtime.agents === null
        ? "unreported"
        : runtime.agents.includes(key)
          ? "online"
          : "offline";
    return { name: agent.name, slug: agent.slug, category: agent.category, status };
  });
  return {
    checkedAt,
    api: { status: "ok" as const, ...(commit ? { commit } : {}) },
    database,
    superAgents,
    summary: {
      online: superAgents.filter((agent) => agent.status === "online").length,
      total: superAgents.length,
    },
  };
}

/** The current status, refreshed at most once a minute. */
export function platformStatus(commit: string | undefined) {
  if (!cached || Date.now() - cached.at >= CACHE_MS) {
    const value = checkStatus(commit);
    cached = { at: Date.now(), value };
    value.catch(() => {
      cached = null;
    });
  }
  return cached.value;
}

export function resetStatusCache() {
  cached = null;
}
