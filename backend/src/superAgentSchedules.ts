import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { audit } from "./audit.js";
import { selfSettlementLimit } from "./capacity.js";
import { env } from "./config.js";
import { resolveJobEscrowMode } from "./jobEscrowMode.js";
import { encryptPayload, payloadContext, payloadDigest } from "./crypto.js";
import { db } from "./db/index.js";
import { ensureEscrowWallet } from "./escrow.js";
import { ApiError } from "./http.js";
import { escrowAccount, transfer, userBalance } from "./ledger.js";
import { readyEnrollment } from "./superAgentEnrollment.js";
import { enqueueWebhookEvent } from "./webhooks.js";

export type SettlementAsset = "usdg" | "liege";
export type Cadence = "daily" | "weekly" | "monthly";

export const cadenceInterval: Record<Cadence, string> = {
  daily: "1 day",
  weekly: "7 days",
  monthly: "1 month",
};

// After this many consecutive failed runs a schedule pauses itself instead of retrying forever.
export const MAX_CONSECUTIVE_FAILURES = 3;

type ReadyAgent = {
  id: string;
  name: string;
  owner_id: string;
  service_slug: string;
  sla_minutes: number;
  description: string;
};

/** The agent must still be an enrolled, verified, discoverable Super Agent for this asset. */
export async function readySuperAgent(
  client: PoolClient,
  agentId: string,
  asset: SettlementAsset,
  userId: string,
  budget: number,
) {
  if (!(budget > 0))
    throw new ApiError(422, "budget_required", `Add a positive ${asset.toUpperCase()} budget.`);
  if (budget >= selfSettlementLimit(asset))
    throw new ApiError(
      422,
      "self_evaluation_limit",
      `Super Agent jobs of ${selfSettlementLimit(asset)} ${asset.toUpperCase()} or more need an independent evaluator.`,
    );
  const agent = await client.query<ReadyAgent>(
    `SELECT a.id,a.name,a.owner_id,s.slug AS service_slug,s.sla_minutes,s.description
     FROM agents a ${readyEnrollment}
     WHERE a.id=$1 AND a.active AND e.enabled AND e.verified_at IS NOT NULL AND $2 = ANY(e.settlement_assets)
     FOR SHARE OF a,e,s,w`,
    [agentId, asset],
  );
  if (!agent.rowCount)
    throw new ApiError(404, "agent_not_found", "The matched Super Agent is unavailable.");
  if (agent.rows[0].owner_id === userId)
    throw new ApiError(422, "self_hire_not_allowed", "An owner cannot hire their own agent.");
  return agent.rows[0];
}

/**
 * Opens an unfunded Super Agent job: the same job an approved proposal creates. The client
 * settles it (no evaluator), so the budget stays below the self-settlement limit.
 */
export async function openSuperAgentJob(
  client: PoolClient,
  input: {
    userId: string;
    agentId: string;
    asset: SettlementAsset;
    budget: number;
    request: string;
    deadlineAt?: string | null;
    policy: Record<string, unknown>;
    title?: string;
  },
) {
  const agent = await readySuperAgent(
    client,
    input.agentId,
    input.asset,
    input.userId,
    input.budget,
  );
  const parsedDeadline = input.deadlineAt ? new Date(input.deadlineAt) : null;
  // Natural-language parsers can return a stale calendar timestamp for relative phrases such as
  // “within 10 minutes”. Treat invalid or expired output as absent and use the service SLA.
  const deadline =
    parsedDeadline && Number.isFinite(parsedDeadline.getTime()) && parsedDeadline > new Date()
      ? parsedDeadline
      : new Date(Date.now() + agent.sla_minutes * 60_000);
  const expires = new Date(deadline.getTime() + 7 * 86_400_000);
  const jobId = randomUUID();
  const title = (input.title ?? `${agent.name}: ${input.request}`).slice(0, 160);
  const created = await client.query(
    `INSERT INTO jobs (id, client_id, agent_id, evaluator_id, kind, title, brief_ciphertext, brief_hash,
       acceptance_criteria, settlement_asset, budget_amount, evaluator_fee_amount, budget_usdg,
       evaluator_fee_usdg, deadline_at, expires_at, strategy_policy, escrow_mode)
     VALUES ($1,$2,$3,NULL,'standard',$4,$5,$6,$7,$8,$9,0,$10,0,$11,$12,$13,$14)
     RETURNING id, public_id, title, status, escrow_mode, settlement_asset, budget_amount, budget_usdg, deadline_at, expires_at`,
    [
      jobId,
      input.userId,
      agent.id,
      title,
      encryptPayload(input.request, payloadContext(jobId, "brief")),
      payloadDigest(input.request),
      JSON.stringify(["Deliver the requested work", agent.description]),
      input.asset,
      String(input.budget),
      input.asset === "usdg" ? String(input.budget) : null,
      deadline,
      expires,
      JSON.stringify({ source: "superagent", serviceSlug: agent.service_slug, ...input.policy }),
      resolveJobEscrowMode(false),
    ],
  );
  if (created.rows[0].escrow_mode === "onchain") await ensureEscrowWallet(client, jobId);
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    jobId,
    input.userId,
    "job.opened",
  ]);
  return created.rows[0] as {
    id: string;
    escrow_mode: "ledger" | "onchain" | "veilora";
    [key: string]: unknown;
  };
}

/**
 * Funds an open ledger job from the client's available balance, as `POST /v1/jobs/:id/fund`
 * does for ledger escrow. On-chain jobs need the client's wallet and are never funded here.
 */
export async function fundLedgerJob(client: PoolClient, jobId: string, userId: string) {
  const found = await client.query<{
    client_id: string;
    status: string;
    escrow_mode: string;
    settlement_asset: SettlementAsset;
    budget_amount: string;
    evaluator_fee_amount: string;
    unfundable: boolean;
  }>(
    `SELECT client_id, status, escrow_mode, COALESCE(settlement_asset, 'usdg') AS settlement_asset,
       COALESCE(budget_amount, budget_usdg) AS budget_amount,
       COALESCE(evaluator_fee_amount, evaluator_fee_usdg, 0) AS evaluator_fee_amount,
       (deadline_at <= now() OR expires_at <= now()) AS unfundable
     FROM jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  const job = found.rows[0];
  if (!job || job.client_id !== userId || job.status !== "open" || job.escrow_mode !== "ledger")
    throw new ApiError(409, "invalid_job_transition", "This job cannot be funded automatically.");
  if (job.unfundable)
    throw new ApiError(409, "job_deadline_passed", "This job can no longer be funded.");
  const available = await userBalance(client, userId, "available", job.settlement_asset);
  await transfer(client, {
    reference: `job-fund:${jobId}`,
    type: "job_fund",
    from: available.accountId,
    to: await escrowAccount(client, jobId, job.settlement_asset),
    asset: job.settlement_asset,
    amount: Number(job.budget_amount) + Number(job.evaluator_fee_amount),
    createdBy: userId,
    metadata: { jobId, scheduled: true },
    insufficientFunds: new ApiError(
      422,
      "insufficient_available_balance",
      `Your available ${job.settlement_asset === "liege" ? "LIEGE" : "USDG"} balance cannot fund this job.`,
    ),
  });
  await client.query(
    "UPDATE jobs SET status = 'funded', funded_at = now(), updated_at = now() WHERE id = $1",
    [jobId],
  );
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    jobId,
    userId,
    "job.funded",
  ]);
  await enqueueWebhookEvent(client, { jobId, eventType: "job.funded", actorId: userId });
}

/** The first slot after `after`, keeping slots anchored to the schedule's start. */
export async function nextSlotAfter(
  client: PoolClient,
  schedule: { starts_at: Date; cadence: Cadence; next_slot: number },
  after: Date,
) {
  const result = await client.query<{ slot: number; at: Date }>(
    `SELECT n AS slot, $1::timestamptz + n * $2::interval AS at
     FROM generate_series($3::int, $3::int + 5000) AS n
     WHERE $1::timestamptz + n * $2::interval > $4::timestamptz
     ORDER BY n LIMIT 1`,
    [schedule.starts_at, cadenceInterval[schedule.cadence], schedule.next_slot, after],
  );
  return result.rows[0];
}

type ScheduleRow = {
  id: string;
  user_id: string;
  agent_id: string;
  request: string;
  settlement_asset: SettlementAsset;
  budget_amount: string;
  cadence: Cadence;
  starts_at: Date;
  next_slot: number;
  next_run_at: Date;
  spend_cap: string;
  committed_amount: string;
  max_runs: number | null;
  runs_count: number;
  auto_fund: boolean;
  consecutive_failures: number;
};

async function runSchedule(client: PoolClient, schedule: ScheduleRow) {
  const budget = Number(schedule.budget_amount);
  const slot = schedule.next_run_at;
  let outcome: "funded" | "awaiting_funding" | "skipped" | "failed";
  let detail: string | null = null;
  let jobId: string | null = null;
  let failures = schedule.consecutive_failures;
  let committed = Number(schedule.committed_amount);
  let runs = schedule.runs_count;

  const waiting = await client.query(
    `SELECT 1 FROM superagent_schedule_runs r JOIN jobs j ON j.id = r.job_id
     WHERE r.schedule_id = $1 AND j.status = 'open' AND j.expires_at > now() LIMIT 1`,
    [schedule.id],
  );
  if (waiting.rowCount) {
    // Never pile up unfunded jobs: one open job per schedule at a time.
    outcome = "skipped";
    detail = "The previous run is still waiting for funding.";
  } else if (committed + budget > Number(schedule.spend_cap)) {
    outcome = "skipped";
    detail = "Spending cap reached.";
  } else {
    await client.query("SAVEPOINT schedule_open");
    try {
      const job = await openSuperAgentJob(client, {
        userId: schedule.user_id,
        agentId: schedule.agent_id,
        asset: schedule.settlement_asset,
        budget,
        request: schedule.request,
        policy: { scheduleId: schedule.id, slot: slot.toISOString() },
      });
      await client.query("RELEASE SAVEPOINT schedule_open");
      jobId = job.id;
      committed += budget;
      runs += 1;
      failures = 0;
      outcome = "awaiting_funding";
      if (!schedule.auto_fund) detail = "Auto-funding is off. Fund this job in the dashboard.";
      else if (job.escrow_mode !== "ledger")
        detail = "On-chain escrow needs your wallet. Fund this job in the dashboard.";
      else {
        await client.query("SAVEPOINT schedule_fund");
        try {
          await fundLedgerJob(client, job.id, schedule.user_id);
          await client.query("RELEASE SAVEPOINT schedule_fund");
          outcome = "funded";
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT schedule_fund");
          detail = `${error.message} Fund this job in the dashboard.`;
        }
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT schedule_open");
      outcome = "failed";
      detail = error.message;
      failures += 1;
    }
  }

  await client.query(
    `INSERT INTO superagent_schedule_runs (schedule_id, slot, job_id, outcome, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [schedule.id, slot, jobId, outcome, detail],
  );
  const next = await nextSlotAfter(
    client,
    { ...schedule, next_slot: schedule.next_slot + 1 },
    new Date(),
  );
  let status = "active";
  let reason: string | null = null;
  if (schedule.max_runs && runs >= schedule.max_runs) {
    status = "completed";
    reason = `All ${schedule.max_runs} runs were created.`;
  } else if (committed + budget > Number(schedule.spend_cap)) {
    status = "completed";
    reason = "Spending cap reached.";
  } else if (failures >= MAX_CONSECUTIVE_FAILURES) {
    status = "paused";
    reason = `Paused after ${failures} failed runs: ${detail}`;
  }
  await client.query(
    `UPDATE superagent_schedules SET next_slot=$2, next_run_at=$3, runs_count=$4, committed_amount=$5,
       consecutive_failures=$6, status=$7, status_reason=COALESCE($8, status_reason), updated_at=now()
     WHERE id=$1`,
    [schedule.id, next.slot, next.at, runs, String(committed), failures, status, reason],
  );
  await audit(client, {
    actorId: schedule.user_id,
    action: "superagent.schedule_run",
    targetType: "superagent_schedule",
    targetId: schedule.id,
    metadata: { slot, outcome, jobId, status },
  });
  return { outcome, jobId };
}

/** Runs every due schedule once. Safe to call from several API instances at the same time. */
export async function processDueSchedules(limit = 50) {
  const results: Array<{ scheduleId: string; outcome: string; jobId: string | null }> = [];
  for (let index = 0; index < limit; index++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<ScheduleRow>(
        `SELECT * FROM superagent_schedules WHERE status = 'active' AND next_run_at <= now()
         ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!due.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const result = await runSchedule(client, due.rows[0]);
      await client.query("COMMIT");
      results.push({ scheduleId: due.rows[0].id, ...result });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Leave the schedule due and stop this pass rather than retrying it in a tight loop.
      console.error("Super Agent schedule run failed:", error);
      break;
    } finally {
      client.release();
    }
  }
  return results;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startSuperAgentScheduler() {
  if (!env.SUPERAGENT_SCHEDULES_INTERVAL_MS || timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void processDueSchedules().finally(() => {
      running = false;
    });
  }, env.SUPERAGENT_SCHEDULES_INTERVAL_MS);
  timer.unref();
}

export function stopSuperAgentScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
