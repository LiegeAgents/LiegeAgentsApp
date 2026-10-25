import type { PoolClient } from "pg";
import { assetLabel, type SettlementAsset } from "./assets.js";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { encryptPayload, payloadContext, payloadDigest } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { releaseLedgerOutcome, type LedgerJob } from "./jobPayouts.js";
import { heldAccounts, transfer } from "./ledger.js";
import { enqueueWebhookEvent } from "./webhooks.js";

/**
 * The challenge window. On a Liege-ledger job with a window, the evaluator's decision is recorded
 * but the escrow stays put until payout_due_at. Before then the side the decision went against
 * (the client for an acceptance, the agent owner for a rejection) may challenge it by posting a
 * bond. A Liege arbitrator then upholds the challenge, which reverses the outcome, or denies it,
 * which keeps the outcome and pays the bond to the other side. Either way the job settles then.
 */

type DecidedJob = LedgerJob & {
  status: string;
  evaluator_id: string | null;
  escrow_mode: string;
  payout_due_at: Date | null;
  payout_released_at: Date | null;
  past_due: boolean;
};

const MIN_BOND: Record<SettlementAsset, number> = { usdg: 0.01, liege: 1 };

export function challengeBond(job: Pick<LedgerJob, "budget_amount" | "settlement_asset">) {
  const decimals = job.settlement_asset === "liege" ? 18 : 6;
  const bond = (Number(job.budget_amount) * env.CHALLENGE_BOND_BPS) / 10_000;
  return Math.max(MIN_BOND[job.settlement_asset], Number(bond.toFixed(decimals)));
}

async function lockDecided(client: PoolClient, jobId: string) {
  const result = await client.query<DecidedJob>(
    `SELECT j.*, a.owner_id AS provider_id, j.payout_due_at <= now() AS past_due
     FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

/** Who decided the job: the evaluator who recorded the decision. */
async function decidedBy(client: PoolClient, jobId: string) {
  const result = await client.query<{ evaluator_id: string; outcome: "accepted" | "rejected" }>(
    "SELECT evaluator_id, outcome FROM evaluations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
    [jobId],
  );
  return result.rows[0];
}

async function settle(
  client: PoolClient,
  job: DecidedJob,
  outcome: "accepted" | "rejected",
  evaluatorId: string,
  actorId: string,
) {
  await releaseLedgerOutcome(client, job, outcome, evaluatorId, actorId);
  const status = outcome === "accepted" ? "completed" : "rejected";
  await client.query(
    `UPDATE jobs SET status = '${status}', settled_at = now(), payout_released_at = now(),
       updated_at = now() WHERE id = $1`,
    [job.id],
  );
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    job.id,
    actorId,
    "job.settled",
  ]);
  await enqueueWebhookEvent(client, { jobId: job.id, eventType: "job.settled", actorId });
}

export async function openChallenge(input: {
  jobId: string;
  userId: string;
  reason: string;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const job = await lockDecided(client, input.jobId);
    if (!job || (job.client_id !== input.userId && job.provider_id !== input.userId))
      throw new ApiError(404, "job_not_found", "This job does not exist.");
    if (job.status === "challenged")
      throw new ApiError(409, "already_challenged", "This decision is already being challenged.");
    if (
      !job.payout_due_at ||
      job.payout_released_at ||
      !["completed", "rejected"].includes(job.status)
    )
      throw new ApiError(
        409,
        "not_challengeable",
        "Only a decision still inside its challenge window can be challenged.",
      );
    if (job.past_due)
      throw new ApiError(409, "challenge_window_closed", "The challenge window has closed.");
    const decision = await decidedBy(client, job.id);
    // The side the decision went against challenges it.
    const loser = decision.outcome === "accepted" ? job.client_id : job.provider_id;
    if (input.userId !== loser)
      throw new ApiError(
        403,
        "not_challenger",
        decision.outcome === "accepted"
          ? "Only the client can challenge an acceptance."
          : "Only the agent owner can challenge a rejection.",
      );
    const bond = challengeBond(job);
    const accounts = await heldAccounts(client, input.userId, job.settlement_asset);
    await transfer(client, {
      reference: `challenge-bond:${job.id}`,
      type: "challenge_bond",
      from: accounts.available,
      to: accounts.held,
      amount: bond,
      asset: job.settlement_asset,
      createdBy: input.userId,
      metadata: { jobId: job.id },
      insufficientFunds: new ApiError(
        402,
        "insufficient_bond",
        `A challenge needs a bond of ${bond} ${assetLabel(job.settlement_asset)} from your available balance. It comes back if the challenge is upheld.`,
      ),
    });
    const dispute = await client.query<{ id: string }>(
      `INSERT INTO disputes (job_id, challenger_id, original_evaluator_id, reason_ciphertext, reason_hash,
         challenge_bond_usdg, asset, decided_outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        job.id,
        input.userId,
        decision.evaluator_id,
        encryptPayload(input.reason, payloadContext(job.id, "challenge")),
        payloadDigest(input.reason),
        bond,
        job.settlement_asset,
        decision.outcome,
      ],
    );
    await client.query("UPDATE jobs SET status = 'challenged', updated_at = now() WHERE id = $1", [
      job.id,
    ]);
    await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
      job.id,
      input.userId,
      "job.challenged",
    ]);
    await audit(client, {
      actorId: input.userId,
      action: "job.challenged",
      targetType: "job",
      targetId: job.id,
      requestId: input.requestId,
      metadata: { disputeId: dispute.rows[0].id, bond, decidedOutcome: decision.outcome },
    });
    await client.query("COMMIT");
    return dispute.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveChallenge(input: {
  disputeId: string;
  resolverId: string;
  resolution: "upheld" | "denied";
  rationale: string;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      id: string;
      job_id: string;
      challenger_id: string;
      original_evaluator_id: string;
      challenge_bond_usdg: string;
      asset: SettlementAsset;
      decided_outcome: "accepted" | "rejected";
      status: string;
    }>("SELECT * FROM disputes WHERE id = $1 FOR UPDATE", [input.disputeId]);
    const dispute = found.rows[0];
    if (!dispute) throw new ApiError(404, "dispute_not_found", "Dispute not found.");
    if (dispute.status !== "open")
      throw new ApiError(409, "dispute_resolved", "This dispute is already resolved.");
    const job = (await lockDecided(client, dispute.job_id))!;
    if ([job.client_id, job.provider_id, dispute.original_evaluator_id].includes(input.resolverId))
      throw new ApiError(
        403,
        "arbitrator_conflict",
        "A party to the job cannot arbitrate its dispute.",
      );
    const upheld = input.resolution === "upheld";
    const finalOutcome = upheld
      ? dispute.decided_outcome === "accepted"
        ? "rejected"
        : "accepted"
      : dispute.decided_outcome;
    // The bond goes back to an upheld challenger, or to the other side of a denied one.
    const counterparty = dispute.challenger_id === job.client_id ? job.provider_id : job.client_id;
    const challenger = await heldAccounts(client, dispute.challenger_id, dispute.asset);
    const bondTo = upheld
      ? challenger.available
      : (await heldAccounts(client, counterparty, dispute.asset)).available;
    await transfer(client, {
      reference: `challenge-bond-${upheld ? "return" : "forfeit"}:${job.id}`,
      type: upheld ? "challenge_bond_return" : "challenge_bond_forfeit",
      from: challenger.held,
      to: bondTo,
      amount: dispute.challenge_bond_usdg,
      asset: dispute.asset,
      createdBy: input.resolverId,
      metadata: { jobId: job.id, disputeId: dispute.id },
    });
    await settle(client, job, finalOutcome, dispute.original_evaluator_id, input.resolverId);
    await client.query(
      `UPDATE disputes SET status = $2, resolution = $3, resolver_id = $4,
         resolution_rationale_ciphertext = $5, resolved_at = now() WHERE id = $1`,
      [
        dispute.id,
        finalOutcome === "accepted" ? "resolved_provider" : "resolved_client",
        input.resolution,
        input.resolverId,
        encryptPayload(input.rationale, payloadContext(job.id, "challenge-resolution")),
      ],
    );
    await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
      job.id,
      input.resolverId,
      `job.challenge_${input.resolution}`,
    ]);
    await audit(client, {
      actorId: input.resolverId,
      action: `dispute.${input.resolution}`,
      targetType: "dispute",
      targetId: dispute.id,
      requestId: input.requestId,
      metadata: { jobId: job.id, finalOutcome },
    });
    await client.query("COMMIT");
    return { disputeId: dispute.id, jobId: job.id, resolution: input.resolution, finalOutcome };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Pays out unchallenged decisions whose window has closed. Each job settles once. */
export async function releaseDuePayouts(limit = 50) {
  const released: string[] = [];
  for (let index = 0; index < limit; index++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ id: string }>(
        `SELECT id FROM jobs WHERE payout_due_at <= now() AND payout_released_at IS NULL
           AND status IN ('completed', 'rejected')
         ORDER BY payout_due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!due.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const job = (await lockDecided(client, due.rows[0].id))!;
      const decision = await decidedBy(client, job.id);
      await settle(client, job, decision.outcome, decision.evaluator_id, decision.evaluator_id);
      await client.query("COMMIT");
      released.push(job.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return released;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startPayoutReleases() {
  if (timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    void releaseDuePayouts().catch((error) =>
      console.error(
        JSON.stringify({
          event: "payouts.release_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 60_000);
  timer.unref();
}
export function stopPayoutReleases() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
