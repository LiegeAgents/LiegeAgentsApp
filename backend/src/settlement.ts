import type { PoolClient } from "pg";
import { parseUnits, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { env } from "./config.js";
import { db } from "./db/index.js";
import {
  escrowSigner,
  viemEscrowChain,
  type EscrowAsset,
  type EscrowChain,
  type ReceiptStatus,
} from "./escrow.js";

// On-chain settlement runs in two phases. Planning happens inside the caller's database
// transaction and only writes rows: the outcome plus one pending payout per transfer. Processing
// happens after commit and is safe to repeat at any point: each payout is bound to one nonce the
// first time it is signed, the signed transaction is stored before it is broadcast, and every
// retry reuses that nonce, so at most one transaction per payout can ever be mined.

const MAX_ATTEMPTS = 8;

let chain: EscrowChain = viemEscrowChain;
// Tests substitute an in-memory chain.
export function useEscrowChain(replacement: EscrowChain) {
  chain = replacement;
}

type Purpose = "provider_payment" | "evaluator_fee" | "client_refund" | "usdg_sweep" | "eth_sweep";
type Payout = {
  id: string;
  purpose: Purpose;
  asset: EscrowAsset;
  recipient: Address;
  amount_raw: string | null;
  status: "pending" | "signed" | "confirmed" | "skipped" | "reverted";
  nonce: number | null;
  signed_tx: Hex | null;
  tx_hashes: Hash[];
};
type Step = "confirmed" | "skipped" | "reverted" | { unresolved: string };
export type SettlementStatus = "complete" | "pending" | "failed" | "busy";

export async function planSettlement(
  client: PoolClient,
  input: {
    jobId: string;
    outcome: "accepted" | "rejected";
    cause: "evaluation" | "expiry";
    // False for a job that expired while open: only whatever reached its wallet is returned.
    funded: boolean;
    clientAddress: string;
    providerAddress: string;
    evaluatorAddress: string;
    budgetUsdg: string;
    evaluatorFeeUsdg: string;
  },
) {
  const budget = parseUnits(input.budgetUsdg, env.USDG_DECIMALS);
  const fee = parseUnits(input.evaluatorFeeUsdg, env.USDG_DECIMALS);
  const payouts: [Purpose, EscrowAsset, string, bigint | null][] = [];
  if (input.funded && input.outcome === "accepted") {
    payouts.push(["provider_payment", "usdg", input.providerAddress, budget]);
    if (fee > 0n) payouts.push(["evaluator_fee", "usdg", input.evaluatorAddress, fee]);
  }
  if (input.funded && input.outcome === "rejected")
    payouts.push(["client_refund", "usdg", input.clientAddress, budget + fee]);
  // Anything else in the wallet (unrecorded or stray deposits, the unused gas reserve) goes back
  // to the client. The ETH sweep is last because every other payout spends gas.
  payouts.push(["usdg_sweep", "usdg", input.clientAddress, null]);
  payouts.push(["eth_sweep", "eth", input.clientAddress, null]);

  await client.query("INSERT INTO escrow_settlements (job_id, outcome, cause) VALUES ($1,$2,$3)", [
    input.jobId,
    input.outcome,
    input.cause,
  ]);
  for (const [position, [purpose, asset, recipient, amount]] of payouts.entries())
    await client.query(
      "INSERT INTO escrow_payouts (job_id, position, purpose, asset, recipient, amount_raw) VALUES ($1,$2,$3,$4,$5,$6)",
      [input.jobId, position, purpose, asset, recipient.toLowerCase(), amount?.toString() ?? null],
    );
}

export async function processSettlement(jobId: string): Promise<SettlementStatus> {
  // The lease keeps concurrent workers off the same wallet; it lapses if a worker dies. Payout
  // updates are conditional as well, so a worker that outlives its lease cannot double-sign.
  const claimed = await db.query(
    "UPDATE escrow_settlements SET lease_until = now() + interval '2 minutes', updated_at = now() WHERE job_id = $1 AND status = 'pending' AND (lease_until IS NULL OR lease_until < now()) RETURNING job_id",
    [jobId],
  );
  if (!claimed.rowCount) {
    const current = await db.query<{ status: SettlementStatus }>(
      "SELECT status FROM escrow_settlements WHERE job_id = $1",
      [jobId],
    );
    return current.rows[0]?.status === "pending" ? "busy" : (current.rows[0]?.status ?? "busy");
  }
  try {
    let account: LocalAccount;
    try {
      account = await escrowSigner(db, jobId);
    } catch (error) {
      return fail(jobId, `The escrow signer is unavailable: ${(error as Error).message}`);
    }
    const payouts = await db.query<Payout>(
      "SELECT * FROM escrow_payouts WHERE job_id = $1 ORDER BY position",
      [jobId],
    );
    for (const payout of payouts.rows) {
      if (payout.status === "confirmed" || payout.status === "skipped") continue;
      if (payout.status === "reverted")
        return fail(jobId, `The ${payout.purpose} transfer reverted.`);
      await db.query(
        "UPDATE escrow_settlements SET lease_until = now() + interval '2 minutes' WHERE job_id = $1",
        [jobId],
      );
      const step = await advance(account, payout).catch((error: unknown): Step => ({
        unresolved: error instanceof Error ? error.message : String(error),
      }));
      if (step === "confirmed" || step === "skipped") continue;
      if (step === "reverted")
        return fail(jobId, `The ${payout.purpose} transfer reverted; nothing was sent.`);
      const attempt = await db.query<{ attempts: number }>(
        "UPDATE escrow_payouts SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1 RETURNING attempts",
        [payout.id, step.unresolved],
      );
      if (attempt.rows[0].attempts >= MAX_ATTEMPTS)
        return fail(
          jobId,
          `The ${payout.purpose} transfer is unresolved after ${MAX_ATTEMPTS} attempts: ${step.unresolved}`,
        );
      return "pending";
    }
    await db.query(
      "UPDATE escrow_settlements SET status = 'complete', error = NULL, updated_at = now() WHERE job_id = $1 AND status = 'pending'",
      [jobId],
    );
    return "complete";
  } catch (error) {
    // A database error outside a payout step; the next run resumes from the stored state.
    console.error(`Escrow settlement for job ${jobId} could not run:`, error);
    return "pending";
  } finally {
    await db.query("UPDATE escrow_settlements SET lease_until = NULL WHERE job_id = $1", [jobId]);
  }
}

export async function processPendingSettlements(limit = 20) {
  const due = await db.query<{ job_id: string }>(
    "SELECT job_id FROM escrow_settlements WHERE status = 'pending' AND (lease_until IS NULL OR lease_until < now()) ORDER BY updated_at LIMIT $1",
    [limit],
  );
  const summary: Record<SettlementStatus, number> = { complete: 0, pending: 0, failed: 0, busy: 0 };
  for (const { job_id } of due.rows) summary[await processSettlement(job_id)]++;
  return summary;
}

async function fail(jobId: string, error: string): Promise<SettlementStatus> {
  await db.query(
    "UPDATE escrow_settlements SET status = 'failed', error = $2, updated_at = now() WHERE job_id = $1",
    [jobId, error],
  );
  console.error(`Escrow settlement for job ${jobId} needs attention: ${error}`);
  return "failed";
}

const isSweep = (payout: Payout) =>
  payout.purpose === "usdg_sweep" || payout.purpose === "eth_sweep";

async function advance(account: LocalAccount, payout: Payout): Promise<Step> {
  const amount = isSweep(payout) ? ("all" as const) : BigInt(payout.amount_raw!);
  if (payout.status === "pending") {
    const nonce = await chain.transactionCount(account.address, "pending");
    const signed = await chain.sign(account, {
      asset: payout.asset,
      to: payout.recipient,
      amount,
      nonce,
    });
    if (!signed) {
      await db.query(
        "UPDATE escrow_payouts SET status = 'skipped', updated_at = now() WHERE id = $1 AND status = 'pending'",
        [payout.id],
      );
      return "skipped";
    }
    const saved = await db.query(
      "UPDATE escrow_payouts SET status = 'signed', nonce = $2, signed_tx = $3, tx_hashes = array_append(tx_hashes, $4), amount_raw = $5, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
      [payout.id, nonce, signed.raw, signed.hash, signed.amount.toString()],
    );
    if (!saved.rowCount) return { unresolved: "Another worker signed this transfer first." };
    return broadcastAndWait(payout.id, signed.raw, signed.hash);
  }

  // Signed before: settle from the chain before sending anything new.
  for (const hash of payout.tx_hashes) {
    const receipt = await chain.receipt(hash);
    if (receipt === "success" || receipt === "reverted") return record(payout.id, hash, receipt);
    if (receipt === "pending") return { unresolved: `Awaiting confirmations for ${hash}.` };
  }
  if ((await chain.transactionCount(account.address, "latest")) > payout.nonce!)
    return {
      unresolved: `Nonce ${payout.nonce} was used, but none of this transfer's transactions has a receipt. If this persists, the escrow key may have been used elsewhere.`,
    };
  // Nothing is mined at this nonce yet. Re-sign at the same nonce so current fees apply; if a
  // sweep now has nothing to send, re-send the stored transaction instead.
  const resigned = await chain.sign(account, {
    asset: payout.asset,
    to: payout.recipient,
    amount,
    nonce: payout.nonce!,
  });
  if (!resigned) return broadcastAndWait(payout.id, payout.signed_tx!, payout.tx_hashes.at(-1)!);
  const saved = await db.query(
    "UPDATE escrow_payouts SET signed_tx = $2, tx_hashes = array_append(tx_hashes, $3), amount_raw = $4, updated_at = now() WHERE id = $1 AND status = 'signed' AND signed_tx = $5 RETURNING id",
    [payout.id, resigned.raw, resigned.hash, resigned.amount.toString(), payout.signed_tx],
  );
  if (!saved.rowCount) return { unresolved: "Another worker re-signed this transfer first." };
  return broadcastAndWait(payout.id, resigned.raw, resigned.hash);
}

async function broadcastAndWait(payoutId: string, raw: Hex, hash: Hash): Promise<Step> {
  await chain.broadcast(raw);
  return record(payoutId, hash, await chain.waitForReceipt(hash));
}

async function record(payoutId: string, hash: Hash, receipt: ReceiptStatus): Promise<Step> {
  if (receipt === "success") {
    await db.query(
      "UPDATE escrow_payouts SET status = 'confirmed', confirmed_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'signed'",
      [payoutId, hash],
    );
    return "confirmed";
  }
  if (receipt === "reverted") {
    await db.query(
      "UPDATE escrow_payouts SET status = 'reverted', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'signed'",
      [payoutId, `Transaction ${hash} reverted.`],
    );
    return "reverted";
  }
  return { unresolved: `No confirmed receipt yet for ${hash}.` };
}
