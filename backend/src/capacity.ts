import type { PoolClient } from "pg";
import { env } from "./config.js";
import type { SettlementAsset } from "./assets.js";

export const MINIMUM_EVALUATOR_STAKE_USDG = 5000;
export const MINIMUM_EVALUATOR_STAKE_LIEGE = 10_000_000;
export const minimumEvaluatorStake = (asset: SettlementAsset) =>
  asset === "liege" ? MINIMUM_EVALUATOR_STAKE_LIEGE : MINIMUM_EVALUATOR_STAKE_USDG;
// An evaluator's stake must be at least this multiple of the budgets they are judging at once.
export const STAKE_COVERAGE = 5;
// A job without an independent evaluator is settled by its client, which is allowed only below
// this budget: otherwise a client could take delivery, reject it, and refund themselves.
export const SELF_SETTLEMENT_LIMIT_USDG = 50;
export const selfSettlementLimit = (asset: SettlementAsset) =>
  asset === "liege" ? env.SELF_SETTLEMENT_LIMIT_LIEGE : SELF_SETTLEMENT_LIMIT_USDG;

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
  change: {
    asset?: SettlementAsset;
    addedExposure?: number;
    stakeAmount?: number;
    // Legacy aliases retained for existing admin callers.
    addedExposureUsdg?: number;
    stakeUsdg?: number;
  } = {},
) {
  const result = await client.query<{
    stake_amount: string;
    exposure_amount: string;
    covered: boolean;
  }>(
    `WITH totals AS (
       SELECT COALESCE((SELECT sum(lp.amount) FROM ledger_accounts la JOIN ledger_postings lp ON lp.account_id = la.id
                        WHERE la.user_id = $1 AND la.kind = 'stake' AND la.asset = $2), 0) AS stake_amount,
              -- Evaluator stake is protocol capacity collateral for the selected rail. USDG and
              -- LIEGE balances are independent and are never converted or combined.
              COALESCE((SELECT sum(COALESCE(budget_amount, budget_usdg)) FROM jobs
                        WHERE evaluator_id = $1 AND settlement_asset = $2 AND status IN ${ACTIVE_STATUSES}), 0) AS exposure_amount
     )
     SELECT stake_amount, exposure_amount,
       (exposure_amount + $3::numeric) * $5 <= COALESCE($4::numeric, stake_amount) AS covered
     FROM totals`,
    [
      userId,
      change.asset ?? "usdg",
      change.addedExposure ?? change.addedExposureUsdg ?? 0,
      change.stakeAmount ?? change.stakeUsdg ?? null,
      STAKE_COVERAGE,
    ],
  );
  const row = result.rows[0];
  return {
    stakeAmount: Number(row.stake_amount),
    exposureAmount: Number(row.exposure_amount),
    // Compatibility aliases for callers that still display USDG-only data.
    stakeUsdg: Number(row.stake_amount),
    exposureUsdg: Number(row.exposure_amount),
    covered: row.covered,
  };
}
