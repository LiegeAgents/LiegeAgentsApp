import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ASSET_DECIMALS, assetLabel, type SettlementAsset } from "./assets.js";
import { audit } from "./audit.js";
import { decryptPayload, encryptPayload, payloadContext } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { heldAccounts, transfer } from "./ledger.js";
import { fundLedgerJob, openSuperAgentJob, readySuperAgent } from "./superAgentSchedules.js";
import { env } from "./config.js";

/**
 * Milestone escrow. The client locks the whole budget up front, from their Liege balance into
 * their held account, so the agent knows the project is paid for. Milestones then run one at a
 * time: each is an ordinary ledger job funded from the locked amount, and the next opens only
 * once the one before it is accepted and settled. A milestone that ends any other way stops the
 * plan, and whatever was never started goes back to the client.
 */

export const MIN_MILESTONES = 2;
export const MAX_MILESTONES = 8;

export type PlanRow = {
  id: string;
  client_id: string;
  agent_id: string;
  title: string;
  brief_ciphertext: string;
  settlement_asset: SettlementAsset;
  status: string;
};

type StepRow = {
  id: string;
  position: number;
  title: string;
  acceptance_criteria: string[];
  amount: string;
  job_id: string | null;
};

const fixed = (value: number, asset: SettlementAsset) =>
  value.toFixed(ASSET_DECIMALS[asset] ?? 6).replace(/\.?0+$/, "");

async function stepsOf(client: PoolClient, planId: string) {
  const result = await client.query<StepRow>(
    `SELECT id, position, title, acceptance_criteria, trim_scale(amount)::text AS amount, job_id
     FROM milestone_plan_steps WHERE plan_id = $1 ORDER BY position`,
    [planId],
  );
  return result.rows;
}

/** The brief a milestone's job carries: the project, the plan, and this milestone's part in it. */
export function milestoneBrief(input: {
  brief: string;
  steps: Array<{ title: string }>;
  position: number;
}) {
  const { brief, steps, position } = input;
  const plan = steps
    .map((step, index) => `${index + 1}. ${step.title}${index === position ? "  <- this one" : ""}`)
    .join("\n");
  return [
    `This job is milestone ${position + 1} of ${steps.length}. The client has locked the budget for every milestone; each is paid when it is accepted, and the next starts then.`,
    "",
    `Project:\n${brief}`,
    "",
    `Milestones:\n${plan}`,
    "",
    `This milestone: ${steps[position].title}`,
  ].join("\n");
}

async function notify(
  client: PoolClient,
  plan: PlanRow,
  input: { jobId: string | null; eventType: string; title: string; message: string },
) {
  await client.query(
    `INSERT INTO notifications (user_id, job_id, event_type, title, message)
     VALUES ($1,$2,$3,$4,$5)`,
    [plan.client_id, input.jobId, input.eventType, input.title, input.message],
  );
}

/**
 * Ends a plan and returns every milestone that never started to the client's available balance.
 * Milestones already running finish on their own.
 */
async function endPlan(
  client: PoolClient,
  plan: PlanRow,
  status: "completed" | "stopped" | "cancelled",
  reason: string,
  actorId: string | null,
) {
  const steps = await stepsOf(client, plan.id);
  const unstarted = steps.filter((step) => !step.job_id);
  const release = unstarted.reduce((sum, step) => sum + Number(step.amount), 0);
  const amount = fixed(release, plan.settlement_asset);
  if (release > 0) {
    const accounts = await heldAccounts(client, plan.client_id, plan.settlement_asset);
    await transfer(client, {
      reference: `milestone-release:${plan.id}`,
      type: "milestone_release",
      from: accounts.held,
      to: accounts.available,
      amount,
      asset: plan.settlement_asset,
      createdBy: actorId ?? undefined,
      metadata: { planId: plan.id, milestones: unstarted.map((step) => step.position) },
    });
  }
  await client.query(
    `UPDATE milestone_plans SET status = $2, status_reason = $3, released_amount = $4,
       updated_at = now() WHERE id = $1`,
    [plan.id, status, reason, release > 0 ? amount : 0],
  );
  return release > 0 ? amount : null;
}

/**
 * Opens and funds one milestone. If the agent can no longer take the job, the plan stops and the
 * rest of the budget is released; that never fails the caller.
 */
async function startMilestone(client: PoolClient, plan: PlanRow, position: number) {
  const steps = await stepsOf(client, plan.id);
  const step = steps[position];
  const brief = decryptPayload(plan.brief_ciphertext, payloadContext(plan.id, "milestones"));
  await client.query("SAVEPOINT milestone_open");
  let jobId: string;
  try {
    const job = await openSuperAgentJob(client, {
      userId: plan.client_id,
      agentId: plan.agent_id,
      asset: plan.settlement_asset,
      budget: Number(step.amount),
      request: milestoneBrief({ brief, steps, position }),
      policy: { milestonePlanId: plan.id, milestone: position },
      title: `${plan.title} · milestone ${position + 1}/${steps.length}: ${step.title}`,
      acceptanceCriteria: step.acceptance_criteria,
      escrowMode: "ledger",
    });
    await fundLedgerJob(client, job.id, plan.client_id, { fromHeld: true });
    await client.query("RELEASE SAVEPOINT milestone_open");
    jobId = job.id;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await client.query("ROLLBACK TO SAVEPOINT milestone_open");
    const reason = `Milestone ${position + 1} could not start: ${error.message}`;
    const released = await endPlan(client, plan, "stopped", reason, null);
    await notify(client, plan, {
      jobId: null,
      eventType: "milestones.stopped",
      title: "Milestone plan stopped",
      message: `${reason}${released ? ` ${released} ${assetLabel(plan.settlement_asset)} went back to your balance.` : ""}`,
    });
    return null;
  }
  await client.query(
    "UPDATE milestone_plan_steps SET job_id = $2, started_at = now() WHERE id = $1",
    [step.id, jobId],
  );
  await client.query("UPDATE milestone_plans SET updated_at = now() WHERE id = $1", [plan.id]);
  return jobId;
}

export async function createMilestonePlan(
  client: PoolClient,
  input: {
    userId: string;
    agentId: string;
    title: string;
    brief: string;
    asset: SettlementAsset;
    milestones: Array<{ title: string; acceptanceCriteria: string[]; amount: number }>;
    requestId?: string;
  },
) {
  const decimals = ASSET_DECIMALS[input.asset] ?? 6;
  for (const milestone of input.milestones)
    if (Number(milestone.amount.toFixed(decimals)) !== milestone.amount)
      throw new ApiError(
        422,
        "invalid_amount",
        `Milestone amounts can have at most ${decimals} decimal places.`,
      );
  // Each milestone is its own client-settled job, so each must fit the self-settlement limit.
  await readySuperAgent(
    client,
    input.agentId,
    input.asset,
    input.userId,
    Math.max(...input.milestones.map((milestone) => milestone.amount)),
  );
  const total = fixed(
    input.milestones.reduce((sum, milestone) => sum + milestone.amount, 0),
    input.asset,
  );
  const planId = randomUUID();
  await client.query(
    `INSERT INTO milestone_plans (id, client_id, agent_id, title, brief_ciphertext, settlement_asset, total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      planId,
      input.userId,
      input.agentId,
      input.title,
      encryptPayload(input.brief, payloadContext(planId, "milestones")),
      input.asset,
      total,
    ],
  );
  for (const [position, milestone] of input.milestones.entries())
    await client.query(
      `INSERT INTO milestone_plan_steps (plan_id, position, title, acceptance_criteria, amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        planId,
        position,
        milestone.title,
        JSON.stringify(milestone.acceptanceCriteria),
        fixed(milestone.amount, input.asset),
      ],
    );
  const accounts = await heldAccounts(client, input.userId, input.asset);
  await transfer(client, {
    reference: `milestone-lock:${planId}`,
    type: "milestone_lock",
    from: accounts.available,
    to: accounts.held,
    amount: total,
    asset: input.asset,
    createdBy: input.userId,
    metadata: { planId },
    insufficientFunds: new ApiError(
      422,
      "insufficient_available_balance",
      `This plan locks ${total} ${assetLabel(input.asset)}, more than your available balance. Top up first.`,
    ),
  });
  const plan = (await lockPlan(client, planId))!;
  const firstJob = await startMilestone(client, plan, 0);
  await audit(client, {
    actorId: input.userId,
    action: "milestones.created",
    targetType: "milestone_plan",
    targetId: planId,
    requestId: input.requestId,
    metadata: { agentId: input.agentId, total, milestones: input.milestones.length, firstJob },
  });
  return planId;
}

async function lockPlan(client: PoolClient, planId: string) {
  const result = await client.query<PlanRow>(
    `SELECT id, client_id, agent_id, title, brief_ciphertext, settlement_asset, status
     FROM milestone_plans WHERE id = $1 FOR UPDATE`,
    [planId],
  );
  return result.rows[0] ?? null;
}

/** The client stops a plan: the running milestone finishes on its own, the rest is released. */
export async function cancelMilestonePlan(planId: string, userId: string, requestId?: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const plan = await lockPlan(client, planId);
    if (!plan || plan.client_id !== userId)
      throw new ApiError(404, "milestone_plan_not_found", "Milestone plan not found.");
    if (plan.status !== "running")
      throw new ApiError(409, "milestone_plan_ended", "This milestone plan has already ended.");
    const released = await endPlan(client, plan, "cancelled", "Cancelled by the client.", userId);
    await audit(client, {
      actorId: userId,
      action: "milestones.cancelled",
      targetType: "milestone_plan",
      targetId: plan.id,
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
 * Moves running plans on once their current milestone has settled: accepted opens the next
 * milestone (or completes the plan), anything else stops it and releases the rest. A decision
 * still inside its challenge window has not settled, so the plan waits for it.
 */
export async function advanceMilestonePlans(limit = 50) {
  const advanced: string[] = [];
  for (let index = 0; index < limit; index++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        id: string;
        position: number;
        job_id: string;
        status: string;
      }>(
        `SELECT p.id, s.position, s.job_id, j.status::text AS status
         FROM milestone_plans p
         JOIN milestone_plan_steps s ON s.plan_id = p.id
         JOIN jobs j ON j.id = s.job_id
         WHERE p.status = 'running' AND j.settled_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM milestone_plan_steps n
                           WHERE n.plan_id = p.id AND n.position > s.position AND n.job_id IS NOT NULL)
         ORDER BY p.updated_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
      );
      if (!due.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const { id, position, job_id: jobId, status } = due.rows[0];
      const plan = (await lockPlan(client, id))!;
      const steps = await stepsOf(client, plan.id);
      if (status === "completed" && position + 1 < steps.length) {
        const next = await startMilestone(client, plan, position + 1);
        if (next)
          await notify(client, plan, {
            jobId: next,
            eventType: "milestones.next",
            title: `Milestone ${position + 2} of ${steps.length} started`,
            message: `"${steps[position].title}" was accepted, so "${steps[position + 1].title}" is funded from your locked budget and with the agent now.`,
          });
      } else if (status === "completed") {
        await endPlan(client, plan, "completed", `All ${steps.length} milestones accepted.`, null);
        await notify(client, plan, {
          jobId,
          eventType: "milestones.completed",
          title: "Milestone plan complete",
          message: `All ${steps.length} milestones of "${plan.title}" were accepted and paid.`,
        });
      } else {
        const reason = `Milestone ${position + 1} ended ${status === "expired" ? "undelivered" : status}.`;
        const released = await endPlan(client, plan, "stopped", reason, null);
        await notify(client, plan, {
          jobId,
          eventType: "milestones.stopped",
          title: "Milestone plan stopped",
          message: `${reason}${released ? ` The ${released} ${assetLabel(plan.settlement_asset)} locked for later milestones went back to your balance.` : ""}`,
        });
      }
      await client.query("COMMIT");
      advanced.push(plan.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return advanced;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startMilestoneAdvances() {
  if (timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    void advanceMilestonePlans().catch((error) =>
      console.error(
        JSON.stringify({
          event: "milestones.advance_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 30_000);
  timer.unref();
}
export function stopMilestoneAdvances() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
