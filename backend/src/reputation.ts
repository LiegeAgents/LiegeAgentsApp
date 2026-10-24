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
    `WITH selected_agents AS (
       SELECT id FROM agents WHERE id = ANY($1::uuid[]) AND active
     ), revision_jobs AS (
       SELECT DISTINCT e.job_id FROM selected_agents a
       JOIN jobs j ON j.agent_id = a.id
       JOIN job_events e ON e.job_id = j.id AND e.event_type = 'job.revision_requested'
     ), job_counts AS (
       SELECT j.agent_id,
         COUNT(*) FILTER (WHERE j.status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE j.status = 'rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE j.status = 'expired' AND j.funded_at IS NOT NULL AND j.submitted_at IS NULL)::int AS undelivered,
         COUNT(*) FILTER (WHERE j.status = 'completed' AND j.submitted_at IS NOT NULL AND j.submitted_at <= j.deadline_at)::int AS on_time,
         COUNT(*) FILTER (WHERE j.status = 'completed' AND r.job_id IS NOT NULL)::int AS completed_with_revision
       FROM jobs j JOIN selected_agents a ON a.id = j.agent_id
       LEFT JOIN revision_jobs r ON r.job_id = j.id
       GROUP BY j.agent_id
     ), dispute_counts AS (
       SELECT j.agent_id, COUNT(*)::int AS disputes_lost
       FROM disputes d JOIN jobs j ON j.id = d.job_id
       JOIN selected_agents a ON a.id = j.agent_id
       WHERE d.status = 'resolved_client'
       GROUP BY j.agent_id
     )
     SELECT a.id,
       COALESCE(j.completed, 0)::int AS completed,
       COALESCE(j.rejected, 0)::int AS rejected,
       COALESCE(j.undelivered, 0)::int AS undelivered,
       COALESCE(j.on_time, 0)::int AS on_time,
       COALESCE(j.completed_with_revision, 0)::int AS completed_with_revision,
       COALESCE(d.disputes_lost, 0)::int AS disputes_lost,
       CASE WHEN e.enabled AND e.verified_at IS NOT NULL AND COALESCE(acc.status, 'active') = 'active'
         THEN e.verified_at ELSE NULL END AS verified_at
     FROM selected_agents a
     LEFT JOIN job_counts j ON j.agent_id = a.id
     LEFT JOIN dispute_counts d ON d.agent_id = a.id
     LEFT JOIN superagent_enrollments e ON e.agent_id = a.id
     LEFT JOIN agent_accounts acc ON acc.agent_id = a.id`,
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
