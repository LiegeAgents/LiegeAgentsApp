import { db } from "./db/index.js";
import { agentStanding } from "./reputation.js";

const CACHE_MS = 60_000;
let cached: { at: number; value: Promise<Awaited<ReturnType<typeof buildLeaderboard>>> } | null =
  null;

/**
 * Agents ranked by their Liege-recorded track record: score first, then recorded outcomes, then
 * verification. Each row carries the latest snapshot of its record anchored on Robinhood Chain.
 * Agents with no recorded outcome are listed only when verified.
 */
async function buildLeaderboard() {
  const agents = await db.query<{ id: string; slug: string; name: string; category: string }>(
    "SELECT id, slug, name, category FROM agents WHERE active",
  );
  const standing = await agentStanding(agents.rows.map((agent) => agent.id));
  const anchored = await db.query<{
    agent_id: string;
    at: string;
    score: number | null;
    tx_hash: string | null;
    block_number: string | null;
    status: "sent" | "confirmed";
  }>(
    `SELECT DISTINCT ON (s.agent_id) s.agent_id, s.snapshot->>'at' AS at,
       (s.snapshot->>'score')::int AS score, b.tx_hash, b.block_number, b.status
     FROM reputation_snapshots s JOIN receipt_batches b ON b.id = s.batch_id
     WHERE b.status IN ('sent', 'confirmed')
     ORDER BY s.agent_id, s.created_at DESC, s.id DESC`,
  );
  const proofs = new Map(anchored.rows.map((row) => [row.agent_id, row]));
  const rows = agents.rows
    .map((agent) => {
      const found = standing.get(agent.id);
      const counts = found?.counts;
      const reputation = found?.reputation;
      const proof = proofs.get(agent.id);
      return {
        slug: agent.slug,
        name: agent.name,
        category: agent.category,
        verified: found?.verified ?? false,
        score: reputation?.status === "scored" ? reputation.score : null,
        outcomes: reputation?.outcomes ?? 0,
        completed: counts?.completed ?? 0,
        onTimeRate: counts?.completed ? counts.onTime / counts.completed : null,
        anchored: proof
          ? {
              at: proof.at,
              score: proof.score,
              status: proof.status,
              txHash: proof.tx_hash,
              blockNumber: proof.block_number ? Number(proof.block_number) : null,
            }
          : null,
      };
    })
    .filter((row) => row.outcomes > 0 || row.verified)
    .sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        b.outcomes - a.outcomes ||
        Number(b.verified) - Number(a.verified) ||
        a.name.localeCompare(b.name),
    );
  return {
    generatedAt: new Date().toISOString(),
    agents: rows.map((row, index) => ({ rank: index + 1, ...row })),
  };
}

/** The leaderboard, rebuilt at most once a minute. */
export function leaderboard() {
  if (!cached || Date.now() - cached.at >= CACHE_MS) {
    const value = buildLeaderboard();
    cached = { at: Date.now(), value };
    value.catch(() => {
      cached = null;
    });
  }
  return cached.value;
}

export function resetLeaderboardCache() {
  cached = null;
}
