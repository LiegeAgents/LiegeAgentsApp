import type { PoolClient } from "pg";

export const MINIMUM_EVALUATOR_STAKE_USDG = 5000;
// An evaluator's stake must be at least this multiple of the budgets they are judging at once.
export const STAKE_COVERAGE = 5;
// A job without an independent evaluator is settled by its client, which is allowed only below
// this budget: otherwise a client could take delivery, reject it, and refund themselves.
export const SELF_SETTLEMENT_LIMIT_USDG = 50;

// Jobs whose budget still counts against the evaluator's stake. Exposure is released when a job
// completes, is rejected, expires, or is cancelled. Nothing is slashed yet: that needs disputes.
const ACTIVE_STATUSES = "('open', 'funded', 'submitted', 'challenged')";

// Locks the evaluator's profile so concurrent job assignments and stake changes serialize.
export async function lockEvaluator(client: PoolClient, userId: string) {
  const profile = await client.query<{ active: boolean }>(
    "SELECT active FROM evaluator_profiles WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  return profile.rows[0] ?? null;
}

// Call after lockEvaluator, as a separate statement, so the sums include anything committed
// while waiting for the lock.
export async function evaluatorPosition(
  client: PoolClient,
  userId: string,
  change: { addedExposureUsdg?: number; stakeUsdg?: number } = {},
) {
  const result = await client.query<{
    stake_usdg: string;
    exposure_usdg: string;
    covered: boolean;
  }>(
    `WITH totals AS (
       SELECT COALESCE((SELECT sum(lp.amount_usdg) FROM ledger_accounts la JOIN ledger_postings lp ON lp.account_id = la.id
                        WHERE la.user_id = $1 AND la.kind = 'stake'), 0) AS stake_usdg,
              COALESCE((SELECT sum(budget_usdg) FROM jobs WHERE evaluator_id = $1 AND status IN ${ACTIVE_STATUSES}), 0) AS exposure_usdg
     )
     SELECT stake_usdg, exposure_usdg,
       (exposure_usdg + $2::numeric) * $4 <= COALESCE($3::numeric, stake_usdg) AS covered
     FROM totals`,
    [userId, change.addedExposureUsdg ?? 0, change.stakeUsdg ?? null, STAKE_COVERAGE],
  );
  const row = result.rows[0];
  return {
    stakeUsdg: Number(row.stake_usdg),
    exposureUsdg: Number(row.exposure_usdg),
    covered: row.covered,
  };
}
