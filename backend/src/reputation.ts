import { db } from "./db/index.js";

/**
 * Reputation is computed from recorded Liege job outcomes only: never owner claims or ratings.
 * Each rate is smoothed toward 50% with one success and one failure added, so a handful of jobs
 * cannot produce a perfect score, and no score is shown below MIN_SCORED_JOBS outcomes.
 */
export const MIN_SCORED_JOBS = 5;
export const REPUTATION_WEIGHTS = { delivery: 0.5, onTime: 0.25, firstPass: 0.15, disputes: 0.1 };

export type OutcomeCounts = {
  completed: number;
  rejected: number;
  // Funded jobs that expired without a submission: the agent never delivered.
  undelivered: number;
  onTime: number;
  // Completed jobs whose client asked for a revision before accepting.
  completedWithRevision: number;
  disputesLost: number;
};

export type Reputation =
  | {
      status: "scored";
      score: number;
      outcomes: number;
      components: { delivery: number; onTime: number; firstPass: number; disputes: number };
    }
  | { status: "not_scored"; score: null; outcomes: number; reason: string };

const smoothed = (successes: number, total: number) => (successes + 1) / (total + 2);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function scoreReputation(counts: OutcomeCounts): Reputation {
  const outcomes = counts.completed + counts.rejected + counts.undelivered;
  if (outcomes < MIN_SCORED_JOBS)
    return {
      status: "not_scored",
      score: null,
      outcomes,
      reason: `Scores start after ${MIN_SCORED_JOBS} completed, rejected, or undelivered jobs (${outcomes} so far).`,
    };
  const components = {
    delivery: smoothed(counts.completed, outcomes),
    // An agent that never delivered earns nothing for punctuality or first-pass acceptance.
    onTime: counts.completed ? smoothed(counts.onTime, counts.completed) : 0,
    firstPass: counts.completed
      ? smoothed(counts.completed - counts.completedWithRevision, counts.completed)
      : 0,
    disputes: 1 - Math.min(1, counts.disputesLost / outcomes),
  };
  const score = (Object.keys(REPUTATION_WEIGHTS) as Array<keyof typeof components>).reduce(
    (sum, key) => sum + REPUTATION_WEIGHTS[key] * components[key],
    0,
  );
  return {
    status: "scored",
    score: Math.round(score * 100),
    outcomes,
    components: {
      delivery: round(components.delivery),
      onTime: round(components.onTime),
      firstPass: round(components.firstPass),
      disputes: round(components.disputes),
    },
  };
}

/**
 * Outcome counts and verification for many agents in one round trip. A verified Super Agent is
 * enrolled, enabled, active, and its runtime answered Liege's signed connection test.
 */
export async function agentStanding(agentIds: string[]) {
  const standing = new Map<
    string,
    { reputation: Reputation; counts: OutcomeCounts; verified: boolean; verifiedAt: string | null }
  >();
  if (!agentIds.length) return standing;
  const result = await db.query<{
    id: string;
    completed: number;
    rejected: number;
    undelivered: number;
    on_time: number;
    completed_with_revision: number;
    disputes_lost: number;
    verified_at: Date | null;
  }>(
    `SELECT a.id,
       COUNT(j.id) FILTER (WHERE j.status = 'completed')::int AS completed,
       COUNT(j.id) FILTER (WHERE j.status = 'rejected')::int AS rejected,
       COUNT(j.id) FILTER (WHERE j.status = 'expired' AND j.funded_at IS NOT NULL AND j.submitted_at IS NULL)::int AS undelivered,
       COUNT(j.id) FILTER (WHERE j.status = 'completed' AND j.submitted_at IS NOT NULL AND j.submitted_at <= j.deadline_at)::int AS on_time,
       COUNT(j.id) FILTER (WHERE j.status = 'completed' AND EXISTS (
         SELECT 1 FROM job_events e WHERE e.job_id = j.id AND e.event_type = 'job.revision_requested'))::int AS completed_with_revision,
       (SELECT COUNT(*) FROM disputes d JOIN jobs dj ON dj.id = d.job_id
          WHERE dj.agent_id = a.id AND d.status = 'resolved_client')::int AS disputes_lost,
       (SELECT e.verified_at FROM superagent_enrollments e
          LEFT JOIN agent_accounts acc ON acc.agent_id = e.agent_id
          WHERE e.agent_id = a.id AND e.enabled AND e.verified_at IS NOT NULL
            AND COALESCE(acc.status, 'active') = 'active') AS verified_at
     FROM agents a LEFT JOIN jobs j ON j.agent_id = a.id
     WHERE a.id = ANY($1::uuid[]) AND a.active
     GROUP BY a.id`,
    [agentIds],
  );
  for (const row of result.rows) {
    const counts: OutcomeCounts = {
      completed: row.completed,
      rejected: row.rejected,
      undelivered: row.undelivered,
      onTime: row.on_time,
      completedWithRevision: row.completed_with_revision,
      disputesLost: row.disputes_lost,
    };
    standing.set(row.id, {
      reputation: scoreReputation(counts),
      counts,
      verified: row.verified_at !== null,
      verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    });
  }
  return standing;
}
