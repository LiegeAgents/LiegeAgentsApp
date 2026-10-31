import type { PoolClient } from "pg";
import { ASSET_DECIMALS, assetLabel, type SettlementAsset } from "./assets.js";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { heldAccounts, transfer } from "./ledger.js";
import { fundLedgerJob, openSuperAgentJob, readySuperAgent } from "./superAgentSchedules.js";

/**
 * Retainers. A client keeps a Super Agent on retainer with a weekly or monthly budget locked from
 * their Liege balance into their held account. Each task they send opens a ledger job funded from
 * that budget at once; the client still accepts or rejects each job. When a period ends, what was
 * not drawn goes back to the client, and an auto-renewing retainer locks the next period's budget.
 */

export type RetainerPeriod = "week" | "month";
const INTERVAL: Record<RetainerPeriod, string> = { week: "7 days", month: "1 month" };

export type RetainerRow = {
  id: string;
  client_id: string;
  agent_id: string;
  agent_owner_id: string;
  title: string;
  settlement_asset: SettlementAsset;
  period: RetainerPeriod;
  budget_amount: string;
  auto_renew: boolean;
  status: string;
  period_number: number;
  period_ends_at: Date;
  drawn: string;
};

const fixed = (value: number, asset: SettlementAsset) =>
  value.toFixed(ASSET_DECIMALS[asset] ?? 6).replace(/\.?0+$/, "");

async function lockRetainer(client: PoolClient, retainerId: string) {
  const result = await client.query<RetainerRow>(
    `SELECT r.id, r.client_id, r.agent_id, a.owner_id AS agent_owner_id, r.title, r.settlement_asset,
       r.period, trim_scale(r.budget_amount)::text AS budget_amount, r.auto_renew, r.status,
       r.period_number, r.period_ends_at,
       trim_scale(COALESCE((SELECT sum(d.amount) FROM retainer_draws d
         WHERE d.retainer_id = r.id AND d.period_number = r.period_number), 0))::text AS drawn
     FROM retainers r JOIN agents a ON a.id = r.agent_id WHERE r.id = $1 FOR UPDATE OF r`,
    [retainerId],
  );
  return result.rows[0] ?? null;
}

/** Moves one period's budget from the client's available balance into held. */
async function lockBudget(client: PoolClient, retainer: RetainerRow, period: number) {
  const accounts = await heldAccounts(client, retainer.client_id, retainer.settlement_asset);
  await transfer(client, {
    reference: `retainer-lock:${retainer.id}:${period}`,
    type: "retainer_lock",
    from: accounts.available,
    to: accounts.held,
    amount: retainer.budget_amount,
    asset: retainer.settlement_asset,
    createdBy: retainer.client_id,
    metadata: { retainerId: retainer.id, period },
    insufficientFunds: new ApiError(
      422,
      "insufficient_available_balance",
      `This retainer locks ${retainer.budget_amount} ${assetLabel(retainer.settlement_asset)} a ${retainer.period}, more than your available balance. Top up first.`,
    ),
  });
}

/** Returns what the current period did not draw to the client's available balance. */
async function releaseUndrawn(client: PoolClient, retainer: RetainerRow, actorId: string | null) {
  const left = Number(retainer.budget_amount) - Number(retainer.drawn);
  if (left <= 0) return null;
  const amount = fixed(left, retainer.settlement_asset);
  const accounts = await heldAccounts(client, retainer.client_id, retainer.settlement_asset);
  await transfer(client, {
    reference: `retainer-release:${retainer.id}:${retainer.period_number}`,
    type: "retainer_release",
    from: accounts.held,
    to: accounts.available,
    amount,
    asset: retainer.settlement_asset,
    createdBy: actorId ?? undefined,
    metadata: { retainerId: retainer.id, period: retainer.period_number },
  });
  return amount;
}

async function notify(
  client: PoolClient,
  userId: string,
  input: { eventType: string; title: string; message: string; jobId?: string },
) {
  await client.query(
    `INSERT INTO notifications (user_id, job_id, event_type, title, message) VALUES ($1,$2,$3,$4,$5)`,
    [userId, input.jobId ?? null, input.eventType, input.title, input.message],
  );
}

export async function createRetainer(
  client: PoolClient,
  input: {
    userId: string;
    agentId: string;
    title: string;
    asset: SettlementAsset;
    period: RetainerPeriod;
    budget: number;
    autoRenew: boolean;
    requestId?: string;
  },
) {
  const decimals = ASSET_DECIMALS[input.asset] ?? 6;
  if (Number(input.budget.toFixed(decimals)) !== input.budget)
    throw new ApiError(
      422,
      "invalid_amount",
      `The budget can have at most ${decimals} decimal places.`,
    );
  // Validates the agent and that the client is not its owner; tasks are checked one by one.
  const agent = await readySuperAgent(client, input.agentId, input.asset, input.userId, 0.000001);
  const created = await client.query<{ id: string }>(
    `INSERT INTO retainers (client_id, agent_id, title, settlement_asset, period, budget_amount,
       auto_renew, period_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + $8::interval) RETURNING id`,
    [
      input.userId,
      input.agentId,
      input.title,
      input.asset,
      input.period,
      fixed(input.budget, input.asset),
      input.autoRenew,
      INTERVAL[input.period],
    ],
  );
  const retainer = (await lockRetainer(client, created.rows[0].id))!;
  await lockBudget(client, retainer, 1);
  await notify(client, agent.owner_id, {
    eventType: "retainer.started",
    title: `${agent.name} was put on retainer`,
    message: `A client locked ${retainer.budget_amount} ${assetLabel(input.asset)} a ${input.period} for "${input.title}". Their tasks arrive as funded jobs.`,
  });
  await audit(client, {
    actorId: input.userId,
    action: "retainer.created",
    targetType: "retainer",
    targetId: retainer.id,
    requestId: input.requestId,
    metadata: { agentId: input.agentId, budget: retainer.budget_amount, period: input.period },
  });
  return retainer.id;
}

/** Sends a task under a retainer: a ledger job funded from this period's budget at once. */
export async function drawRetainer(input: {
  retainerId: string;
  userId: string;
  request: string;
  amount: number;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const retainer = await lockRetainer(client, input.retainerId);
    if (!retainer || retainer.client_id !== input.userId)
      throw new ApiError(404, "retainer_not_found", "Retainer not found.");
    if (retainer.status !== "active")
      throw new ApiError(409, "retainer_ended", "This retainer has ended.");
    const decimals = ASSET_DECIMALS[retainer.settlement_asset] ?? 6;
    if (Number(input.amount.toFixed(decimals)) !== input.amount)
      throw new ApiError(
        422,
        "invalid_amount",
        `The amount can have at most ${decimals} decimal places.`,
      );
    const left = Number(retainer.budget_amount) - Number(retainer.drawn);
    if (input.amount > left + 1e-12)
      throw new ApiError(
        422,
        "retainer_budget_exhausted",
        `This ${retainer.period}'s retainer has ${fixed(Math.max(0, left), retainer.settlement_asset)} ${assetLabel(retainer.settlement_asset)} left. It renews ${retainer.period_ends_at.toUTCString()}.`,
      );
    const job = await openSuperAgentJob(client, {
      userId: retainer.client_id,
      agentId: retainer.agent_id,
      asset: retainer.settlement_asset,
      budget: input.amount,
      request: input.request,
      policy: { retainerId: retainer.id, retainerPeriod: retainer.period_number },
      title: `${retainer.title}: ${input.request}`,
      escrowMode: "ledger",
    });
    await fundLedgerJob(client, job.id, retainer.client_id, { fromHeld: "retainer_fund" });
    await client.query(
      "INSERT INTO retainer_draws (job_id, retainer_id, period_number, amount) VALUES ($1,$2,$3,$4)",
      [job.id, retainer.id, retainer.period_number, fixed(input.amount, retainer.settlement_asset)],
    );
    await client.query("UPDATE retainers SET updated_at = now() WHERE id = $1", [retainer.id]);
    await audit(client, {
      actorId: input.userId,
      action: "retainer.drawn",
      targetType: "retainer",
      targetId: retainer.id,
      requestId: input.requestId,
      metadata: { jobId: job.id, amount: input.amount },
    });
    await client.query("COMMIT");
    return job.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The client ends a retainer: this period's undrawn budget returns; open tasks finish. */
export async function cancelRetainer(retainerId: string, userId: string, requestId?: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const retainer = await lockRetainer(client, retainerId);
    if (!retainer || retainer.client_id !== userId)
      throw new ApiError(404, "retainer_not_found", "Retainer not found.");
    if (retainer.status !== "active")
      throw new ApiError(409, "retainer_ended", "This retainer has already ended.");
    const released = await releaseUndrawn(client, retainer, userId);
    await client.query(
      `UPDATE retainers SET status = 'cancelled', status_reason = 'Cancelled by the client.',
         updated_at = now() WHERE id = $1`,
      [retainer.id],
    );
    await notify(client, retainer.agent_owner_id, {
      eventType: "retainer.ended",
      title: "A retainer ended",
      message: `The client cancelled the retainer "${retainer.title}". Tasks already sent finish as usual.`,
    });
    await audit(client, {
      actorId: userId,
      action: "retainer.cancelled",
      targetType: "retainer",
      targetId: retainer.id,
      requestId,
      metadata: { released },
    });
    await client.query("COMMIT");
    return released;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Closes retainer periods that have ended: the undrawn budget goes back to the client, and an
 * auto-renewing retainer locks the next period's budget. If that budget cannot be locked (the
 * balance, a spend limit, or the agent is no longer available), the retainer ends instead.
 */
export async function rollRetainers(limit = 50) {
  const rolled: string[] = [];
  for (let index = 0; index < limit; index++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ id: string }>(
        `SELECT id FROM retainers WHERE status = 'active' AND period_ends_at <= now()
         ORDER BY period_ends_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!due.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const retainer = (await lockRetainer(client, due.rows[0].id))!;
      const released = await releaseUndrawn(client, retainer, null);
      const returned = released
        ? ` ${released} ${assetLabel(retainer.settlement_asset)} not used this ${retainer.period} went back to your balance.`
        : "";
      let endReason: string | null = retainer.auto_renew ? null : "The period ended.";
      if (!endReason) {
        await client.query("SAVEPOINT retainer_renew");
        try {
          await readySuperAgent(
            client,
            retainer.agent_id,
            retainer.settlement_asset,
            retainer.client_id,
            0.000001,
          );
          await lockBudget(client, retainer, retainer.period_number + 1);
          await client.query("RELEASE SAVEPOINT retainer_renew");
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT retainer_renew");
          endReason = `It could not renew: ${error.message}`;
        }
      }
      if (endReason) {
        await client.query(
          `UPDATE retainers SET status = 'ended', status_reason = $2, updated_at = now() WHERE id = $1`,
          [retainer.id, endReason],
        );
        await notify(client, retainer.client_id, {
          eventType: "retainer.ended",
          title: "Your retainer ended",
          message: `"${retainer.title}" ended. ${endReason}${returned}`,
        });
      } else {
        // Periods stay anchored to the start, so a late run does not drift the schedule.
        await client.query(
          `UPDATE retainers SET period_number = period_number + 1,
             period_started_at = period_ends_at,
             period_ends_at = period_ends_at + $2::interval, updated_at = now()
           WHERE id = $1`,
          [retainer.id, INTERVAL[retainer.period]],
        );
        await notify(client, retainer.client_id, {
          eventType: "retainer.renewed",
          title: "Your retainer renewed",
          message: `"${retainer.title}" renewed with ${retainer.budget_amount} ${assetLabel(retainer.settlement_asset)} for the next ${retainer.period}.${returned}`,
        });
      }
      await client.query("COMMIT");
      rolled.push(retainer.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return rolled;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startRetainerRolls() {
  if (timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    void rollRetainers().catch((error) =>
      console.error(
        JSON.stringify({
          event: "retainers.roll_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 60_000);
  timer.unref();
}
export function stopRetainerRolls() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
