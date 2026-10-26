import type { PoolClient } from "pg";
import { formatUnits, parseUnits } from "viem";
import type { SettlementAsset } from "./assets.js";
import { env } from "./config.js";
import { encryptPayload, payloadContext, payloadDigest } from "./crypto.js";
import { escrowAccount, transfer, userBalance } from "./ledger.js";
import { planSettlement, processSettlement } from "./settlement.js";
import { enqueueWebhookEvent } from "./webhooks.js";

export type LedgerJob = {
  id: string;
  escrow_mode?: string;
  challenge_window_hours?: number | null;
  client_id: string;
  provider_id: string;
  settlement_asset: SettlementAsset;
  budget_amount: string | number;
  evaluator_fee_amount: string | number | null;
  evaluator_fee_usdg: string | number | null;
};

export const evaluatorFeeOf = (job: LedgerJob) =>
  job.settlement_asset === "usdg"
    ? String(job.evaluator_fee_usdg ?? job.evaluator_fee_amount ?? 0)
    : String(job.evaluator_fee_amount ?? 0);

/**
 * Pays out a Liege-ledger job's escrow for its final outcome. Accepted: squad members their
 * shares, the provider the rest of the budget, and the evaluator their fee. Rejected: the client
 * gets everything back. Transfer references are per job, so a payout can never happen twice.
 */
export async function releaseLedgerOutcome(
  client: PoolClient,
  job: LedgerJob,
  outcome: "accepted" | "rejected",
  evaluatorId: string,
  actorId: string,
) {
  const asset = job.settlement_asset;
  const fee = evaluatorFeeOf(job);
  const escrow = await escrowAccount(client, job.id, asset);
  if (outcome === "rejected") {
    const clientBalance = await userBalance(client, job.client_id, "available", asset);
    await transfer(client, {
      reference: `job-refund:${job.id}`,
      type: "job_refund",
      from: escrow,
      to: clientBalance.accountId,
      amount: Number(job.budget_amount) + Number(fee),
      asset,
      createdBy: actorId,
      metadata: { jobId: job.id },
    });
    return;
  }
  const decimals = asset === "liege" ? 18 : 6;
  const budgetRaw = parseUnits(String(job.budget_amount), decimals);
  const members = await client.query<{ owner_id: string; allocation_bps: number }>(
    `SELECT a.owner_id, la.allocation_bps FROM legion_assignments la
     JOIN legions l ON l.id = la.legion_id JOIN agents a ON a.id = la.agent_id
     WHERE l.job_id = $1 AND la.status = 'submitted' ORDER BY la.created_at`,
    [job.id],
  );
  let delegatedRaw = 0n;
  for (const member of members.rows) {
    const shareRaw = (budgetRaw * BigInt(member.allocation_bps)) / 10_000n;
    if (shareRaw === 0n) continue;
    delegatedRaw += shareRaw;
    const memberBalance = await userBalance(client, member.owner_id, "available", asset);
    await transfer(client, {
      reference: `job-settle-legion:${job.id}:${member.owner_id}`,
      type: "legion_settlement",
      from: escrow,
      to: memberBalance.accountId,
      amount: formatUnits(shareRaw, decimals),
      asset,
      createdBy: actorId,
      metadata: { jobId: job.id, allocationBps: member.allocation_bps },
    });
  }
  const provider = await userBalance(client, job.provider_id, "available", asset);
  await transfer(client, {
    reference: `job-settle-provider:${job.id}`,
    type: "job_settlement",
    from: escrow,
    to: provider.accountId,
    amount: formatUnits(budgetRaw - delegatedRaw, decimals),
    asset,
    createdBy: actorId,
    metadata: { jobId: job.id },
  });
  if (Number(fee) > 0) {
    const evaluator = await userBalance(client, evaluatorId, "available", asset);
    await transfer(client, {
      reference: `job-settle-evaluator:${job.id}`,
      type: "evaluator_fee",
      from: escrow,
      to: evaluator.accountId,
      amount: Number(fee),
      asset,
      createdBy: actorId,
      metadata: { jobId: job.id },
    });
  }
}

/**
 * Pays out a decided job on its final outcome in whichever escrow holds it: the ledger moves at
 * once; a Liege onchain escrow wallet gets its transfers planned in this transaction, and they are
 * sent after commit (startOnchainSettlement), with the settle-escrows cron retrying failures.
 * Returns whether onchain transfers were planned.
 */
export async function settleOutcome(
  client: PoolClient,
  job: LedgerJob,
  outcome: "accepted" | "rejected",
  evaluatorId: string,
  actorId: string,
) {
  if (job.escrow_mode !== "onchain") {
    await releaseLedgerOutcome(client, job, outcome, evaluatorId, actorId);
    return false;
  }
  const addresses = await client.query<{
    client_address: string;
    provider_address: string;
    evaluator_address: string;
  }>(
    `SELECT c.wallet_address AS client_address, p.wallet_address AS provider_address,
       e.wallet_address AS evaluator_address
     FROM users c, users p, users e WHERE c.id = $1 AND p.id = $2 AND e.id = $3`,
    [job.client_id, job.provider_id, evaluatorId],
  );
  const row = addresses.rows[0];
  await planSettlement(client, {
    jobId: job.id,
    outcome,
    cause: "evaluation",
    funded: true,
    clientAddress: row.client_address,
    providerAddress: row.provider_address,
    evaluatorAddress: row.evaluator_address,
    budget: String(job.budget_amount),
    evaluatorFee: evaluatorFeeOf(job),
    asset: job.settlement_asset,
  });
  return true;
}

/** Sends the onchain transfers planned for a job once their transaction has committed. */
export function startOnchainSettlement(jobId: string) {
  void processSettlement(jobId).catch((error) =>
    console.error(`Escrow settlement for job ${jobId} could not start:`, error),
  );
}

/**
 * Records a decision made without a person reviewing it (passing approval rules) exactly as an
 * evaluation would: the payout waits out the challenge window if the job has one, and is released
 * at once otherwise. Call startOnchainSettlement after commit when `onchain` is true.
 */
export async function recordDecision(
  client: PoolClient,
  job: LedgerJob,
  input: { outcome: "accepted" | "rejected"; evaluatorId: string; rationale: string },
) {
  const windowHours = job.challenge_window_hours ?? env.CHALLENGE_WINDOW_HOURS;
  const onchain = windowHours
    ? false
    : await settleOutcome(client, job, input.outcome, input.evaluatorId, input.evaluatorId);
  await client.query(
    "INSERT INTO evaluations (job_id, evaluator_id, outcome, rationale_ciphertext, rationale_hash) VALUES ($1,$2,$3,$4,$5)",
    [
      job.id,
      input.evaluatorId,
      input.outcome,
      encryptPayload(input.rationale, payloadContext(job.id, "rationale")),
      payloadDigest(input.rationale),
    ],
  );
  const status = input.outcome === "accepted" ? "completed" : "rejected";
  const updated = windowHours
    ? await client.query(
        `UPDATE jobs SET status = '${status}', challenge_window_hours = $2,
           payout_due_at = now() + ($2::int * interval '1 hour'), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [job.id, windowHours],
      )
    : await client.query(
        `UPDATE jobs SET status = '${status}', settled_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [job.id],
      );
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    job.id,
    input.evaluatorId,
    `job.${status}`,
  ]);
  await enqueueWebhookEvent(client, {
    jobId: job.id,
    eventType: `job.${status}`,
    actorId: input.evaluatorId,
  });
  return { job: updated.rows[0], onchain };
}
