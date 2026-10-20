import type { PoolClient } from "pg";
import { z } from "zod";
import { decryptPayload, encryptPayload, payloadContext } from "./crypto.js";
import { ApiError } from "./http.js";

/** Chains Constantine can check. Keys match the runtime's `chains` in `constantine.ts`. */
export const watchChains = {
  robinhood: "Robinhood Chain",
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  bsc: "BNB Chain",
} as const;
export type WatchChain = keyof typeof watchChains;

const share = z.number().finite().min(0).max(1).nullable();

/**
 * One run's result, as Constantine's runtime reports it alongside the delivery. `null` always
 * means "not known on this run" (a data source failed or had nothing), never "absent".
 */
export const watchSnapshot = z
  .object({
    version: z.literal(1),
    symbol: z.string().trim().max(40).nullable(),
    verdict: z.string().trim().min(1).max(40),
    riskScore: z.number().int().min(0).max(100).nullable(),
    honeypot: z.boolean().nullable(),
    cannotSellAll: z.boolean().nullable(),
    noSells: z.boolean().nullable(),
    // "" when the contract has no owner function; an address otherwise.
    owner: z
      .string()
      .regex(/^(0x[0-9a-fA-F]{40})?$/)
      .transform((value) => value.toLowerCase())
      .nullable(),
    hiddenOwner: z.boolean().nullable(),
    canTakeBackOwnership: z.boolean().nullable(),
    liquidityUsd: z.number().finite().min(0).nullable(),
    lpLockedShare: share,
    buyTax: share,
    sellTax: share,
    transferTax: share,
  })
  .strict();
export type WatchSnapshot = z.infer<typeof watchSnapshot>;

export type WatchChange = {
  signal: "honeypot" | "ownership" | "liquidity" | "tax";
  label: string;
  detail: string;
};

const burned = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const ownerText = (owner: string) =>
  owner === "" ? "no owner" : burned.has(owner) ? "renounced" : short(owner);
const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
const usd = (value: number) =>
  `$${value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : value.toFixed(2)}`;

/** Liquidity below this is a red flag in Constantine's checks too. */
export const LIQUIDITY_FLOOR_USD = 5_000;

/**
 * The signals that got worse between two runs. A field unknown on either run is skipped, so a
 * provider outage never looks like a rug; improvements are never alerts.
 */
export function compareWatchSnapshots(previous: WatchSnapshot, next: WatchSnapshot) {
  const changes: WatchChange[] = [];
  const appeared = (key: "honeypot" | "cannotSellAll" | "noSells") =>
    previous[key] === false && next[key] === true;

  if (appeared("honeypot"))
    changes.push({
      signal: "honeypot",
      label: "Honeypot",
      detail: "Simulated sells now fail: buyers cannot sell.",
    });
  if (appeared("cannotSellAll"))
    changes.push({
      signal: "honeypot",
      label: "Sell limit",
      detail: "Holders can no longer sell their whole balance.",
    });
  if (appeared("noSells"))
    changes.push({
      signal: "honeypot",
      label: "No sells",
      detail: "The main pool now shows buys and no sells in 24 hours.",
    });

  if (previous.owner !== null && next.owner !== null && previous.owner !== next.owner)
    changes.push({
      signal: "ownership",
      label: "Owner changed",
      detail: `Ownership moved from ${ownerText(previous.owner)} to ${ownerText(next.owner)}.`,
    });
  if (previous.hiddenOwner === false && next.hiddenOwner === true)
    changes.push({
      signal: "ownership",
      label: "Hidden owner",
      detail: "Someone now keeps owner powers behind the scenes.",
    });
  if (previous.canTakeBackOwnership === false && next.canTakeBackOwnership === true)
    changes.push({
      signal: "ownership",
      label: "Ownership can be reclaimed",
      detail: "A renounced owner can now take control back.",
    });

  if (previous.liquidityUsd !== null && next.liquidityUsd !== null) {
    const halved = previous.liquidityUsd > 0 && next.liquidityUsd <= previous.liquidityUsd * 0.5;
    const floor =
      previous.liquidityUsd >= LIQUIDITY_FLOOR_USD && next.liquidityUsd < LIQUIDITY_FLOOR_USD;
    if (halved || floor)
      changes.push({
        signal: "liquidity",
        label: "Liquidity pulled",
        detail: `Pool liquidity fell from ${usd(previous.liquidityUsd)} to ${usd(next.liquidityUsd)}.`,
      });
  }
  if (
    previous.lpLockedShare !== null &&
    next.lpLockedShare !== null &&
    previous.lpLockedShare >= 0.9 &&
    next.lpLockedShare < 0.9
  )
    changes.push({
      signal: "liquidity",
      label: "Liquidity unlocked",
      detail: `Locked or burned liquidity fell from ${percent(previous.lpLockedShare)} to ${percent(next.lpLockedShare)}.`,
    });

  for (const [key, label] of [
    ["buyTax", "Buy tax"],
    ["sellTax", "Sell tax"],
    ["transferTax", "Transfer tax"],
  ] as const) {
    const before = previous[key];
    const after = next[key];
    // One percentage point, with a little room for floating-point noise in the source data.
    if (before !== null && after !== null && after - before >= 0.01 - 1e-9)
      changes.push({
        signal: "tax",
        label: `${label} raised`,
        detail: `${label} rose from ${percent(before)} to ${percent(after)}.`,
      });
  }
  return changes;
}

const watchPolicy = (policy: unknown) => {
  const value = (policy ?? {}) as Record<string, unknown>;
  return value.watch === true && typeof value.scheduleId === "string"
    ? { scheduleId: value.scheduleId }
    : null;
};

/**
 * Records a watch run's result with its delivery, in the submit transaction, and alerts the
 * watch's owner when a signal worsened since the previous run.
 */
export async function recordWatchRun(
  client: PoolClient,
  job: { id: string; title: string; strategy_policy: unknown },
  providerId: string,
  snapshot: WatchSnapshot | undefined,
) {
  const policy = watchPolicy(job.strategy_policy);
  if (!snapshot) return null;
  if (!policy)
    throw new ApiError(
      422,
      "watch_snapshot_not_allowed",
      "Only a watchlist run can carry a watch result.",
    );
  const schedule = await client.query<{
    user_id: string;
    watch_token: string;
    watch_chain: WatchChain;
  }>(
    "SELECT user_id, watch_token, watch_chain FROM superagent_schedules WHERE id = $1 AND watch_token IS NOT NULL",
    [policy.scheduleId],
  );
  if (!schedule.rowCount)
    throw new ApiError(
      422,
      "watch_snapshot_not_allowed",
      "Only a watchlist run can carry a watch result.",
    );
  const watch = schedule.rows[0];
  const previous = await client.query<{ job_id: string; snapshot_ciphertext: string }>(
    `SELECT job_id, snapshot_ciphertext FROM superagent_watch_runs
     WHERE schedule_id = $1 AND job_id <> $2 ORDER BY created_at DESC LIMIT 1`,
    [policy.scheduleId, job.id],
  );
  const last = previous.rows[0];
  const changes = last
    ? compareWatchSnapshots(
        watchSnapshot.parse(
          JSON.parse(
            decryptPayload(last.snapshot_ciphertext, payloadContext(last.job_id, "watch-snapshot")),
          ),
        ),
        snapshot,
      )
    : [];
  await client.query(
    `INSERT INTO superagent_watch_runs (job_id, schedule_id, snapshot_ciphertext, verdict, risk_score, baseline, changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (job_id) DO UPDATE SET snapshot_ciphertext = EXCLUDED.snapshot_ciphertext,
       verdict = EXCLUDED.verdict, risk_score = EXCLUDED.risk_score, baseline = EXCLUDED.baseline,
       changes = EXCLUDED.changes, updated_at = now()`,
    [
      job.id,
      policy.scheduleId,
      encryptPayload(JSON.stringify(snapshot), payloadContext(job.id, "watch-snapshot")),
      snapshot.verdict,
      snapshot.riskScore,
      !last,
      JSON.stringify(changes),
    ],
  );
  if (!changes.length) return { baseline: !last, changes };

  const token = `${snapshot.symbol ?? short(watch.watch_token)} on ${watchChains[watch.watch_chain]}`;
  const event = await client.query<{ id: string; created_at: Date }>(
    "INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1,$2,'watch.alert',$3) RETURNING id, created_at",
    [job.id, providerId, JSON.stringify({ scheduleId: policy.scheduleId, changes })],
  );
  await client.query(
    `INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
     VALUES ($1,$2,$3,'watch.alert',$4,$5,$6) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [
      watch.user_id,
      job.id,
      event.rows[0].id,
      `Watchlist alert: ${token}`,
      `${changes.map((change) => change.detail).join(" ")} Open the run for Constantine's full report.`,
      event.rows[0].created_at,
    ],
  );
  return { baseline: false, changes };
}
