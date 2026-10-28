import type { PoolClient } from "pg";
import { ApiError } from "./http.js";

/** Debits of the available balance that count as spending, and the refunds that give it back. */
export const SPENDING_TYPES = ["job_fund", "call_hold", "job_bonus", "invoice_payment"];
const REFUND_TYPES = [
  "job_refund",
  "job_expiry_refund",
  "call_refund",
  "invoice_refund",
  "late_delivery_refund",
];

/**
 * The limits in force: a raise or removal scheduled for `next_at` replaces the current limits
 * once that time has passed. Used by the transfer check and the settings routes alike.
 */
export const effectiveLimits = `
  CASE WHEN next_at <= now() THEN next_daily_limit ELSE daily_limit END AS daily_limit,
  CASE WHEN next_at <= now() THEN next_monthly_limit ELSE monthly_limit END AS monthly_limit`;

/** Net spending from an available account in the last day and the last 30 days. */
export const spentSql = `
  SELECT
    GREATEST(0, -COALESCE(sum(p.amount) FILTER (WHERE p.created_at > now() - interval '1 day'), 0)) AS day,
    GREATEST(0, -COALESCE(sum(p.amount), 0)) AS month
  FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
  WHERE p.account_id = $1 AND p.created_at > now() - interval '30 days'
    AND t.type = ANY($2::text[])`;
export const countedTypes = [...SPENDING_TYPES, ...REFUND_TYPES];

/**
 * Refuses a spending debit that would take the owner past a limit. The caller holds the
 * account's lock, so two debits cannot both pass on the same remaining allowance.
 */
export async function enforceSpendLimit(client: PoolClient, accountId: string, amount: string) {
  const found = await client.query<{
    asset: string;
    daily_limit: string | null;
    monthly_limit: string | null;
    day: string;
    month: string;
  }>(
    `SELECT l.asset, trim_scale(l.daily_limit)::text AS daily_limit,
       trim_scale(l.monthly_limit)::text AS monthly_limit,
       trim_scale(s.day)::text AS day, trim_scale(s.month)::text AS month
     FROM (SELECT s.asset, ${effectiveLimits} FROM spend_limits s
           JOIN ledger_accounts a ON a.user_id = s.user_id AND a.asset = s.asset
           WHERE a.id = $1) l,
       LATERAL (${spentSql}) s`,
    [accountId, countedTypes],
  );
  const row = found.rows[0];
  if (!row) return;
  const label = row.asset.toUpperCase();
  for (const [limit, spent, window] of [
    [row.daily_limit, row.day, "24 hours"],
    [row.monthly_limit, row.month, "30 days"],
  ] as const) {
    if (limit === null) continue;
    const total = Number(spent) + Number(amount);
    if (total > Number(limit) + 1e-12)
      throw new ApiError(
        422,
        "spend_limit_reached",
        `This would bring your ${label} spending in the last ${window} to ${+total.toFixed(6)}, over your limit of ${limit}. Change it in Settings.`,
      );
  }
}

type Limits = { daily: number | null; monthly: number | null };
const tighter = (next: number | null, current: number | null) =>
  next !== null && (current === null || next <= current);

/** A workspace's limits for one asset, any scheduled change, and its spending so far. */
export async function readSpendLimits(client: PoolClient, userId: string, accountId: string) {
  const asset = (
    await client.query<{ asset: string }>("SELECT asset FROM ledger_accounts WHERE id = $1", [
      accountId,
    ])
  ).rows[0].asset;
  const [limits, spent] = await Promise.all([
    client.query<{
      daily_limit: string | null;
      monthly_limit: string | null;
      next_daily_limit: string | null;
      next_monthly_limit: string | null;
      next_at: Date | null;
    }>(
      `SELECT trim_scale(daily_limit)::text AS daily_limit,
         trim_scale(monthly_limit)::text AS monthly_limit,
         trim_scale(next_daily_limit)::text AS next_daily_limit,
         trim_scale(next_monthly_limit)::text AS next_monthly_limit,
         CASE WHEN next_at > now() THEN next_at END AS next_at
       FROM (SELECT ${effectiveLimits}, next_daily_limit, next_monthly_limit, next_at
             FROM spend_limits WHERE user_id = $1 AND asset = $2) l`,
      [userId, asset],
    ),
    client.query<{ day: string; month: string }>(
      `SELECT trim_scale(day)::text AS day, trim_scale(month)::text AS month FROM (${spentSql}) s`,
      [accountId, countedTypes],
    ),
  ]);
  const row = limits.rows[0];
  return {
    asset,
    daily: row?.daily_limit ?? null,
    monthly: row?.monthly_limit ?? null,
    scheduled: row?.next_at
      ? { daily: row.next_daily_limit, monthly: row.next_monthly_limit, at: row.next_at }
      : null,
    spent: { day: spent.rows[0].day, month: spent.rows[0].month },
  };
}

/**
 * Sets an asset's limits (null for none). A tighter limit applies at once; a looser one, or
 * removing one, is scheduled for 24 hours from now and replaces any earlier scheduled change.
 */
export async function setSpendLimits(
  client: PoolClient,
  userId: string,
  asset: string,
  requested: Limits,
) {
  const found = await client.query<{ daily_limit: string | null; monthly_limit: string | null }>(
    `SELECT ${effectiveLimits} FROM spend_limits WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
    [userId, asset],
  );
  const current = {
    daily: found.rows[0]?.daily_limit == null ? null : Number(found.rows[0].daily_limit),
    monthly: found.rows[0]?.monthly_limit == null ? null : Number(found.rows[0].monthly_limit),
  };
  const now = {
    daily: tighter(requested.daily, current.daily) ? requested.daily : current.daily,
    monthly: tighter(requested.monthly, current.monthly) ? requested.monthly : current.monthly,
  };
  const waits = now.daily !== requested.daily || now.monthly !== requested.monthly;
  await client.query(
    `INSERT INTO spend_limits (user_id, asset, daily_limit, monthly_limit, next_daily_limit,
       next_monthly_limit, next_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN now() + interval '1 day' END)
     ON CONFLICT (user_id, asset) DO UPDATE SET daily_limit = EXCLUDED.daily_limit,
       monthly_limit = EXCLUDED.monthly_limit, next_daily_limit = EXCLUDED.next_daily_limit,
       next_monthly_limit = EXCLUDED.next_monthly_limit, next_at = EXCLUDED.next_at,
       updated_at = now()`,
    [
      userId,
      asset,
      now.daily,
      now.monthly,
      waits ? requested.daily : null,
      waits ? requested.monthly : null,
      waits,
    ],
  );
  return waits;
}
