import type { PoolClient } from "pg";
import { formatUnits, parseUnits } from "viem";
import type { SettlementAsset } from "./assets.js";
import { escrowAccount, transfer, userBalance } from "./ledger.js";

export type LedgerJob = {
  id: string;
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
