import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, toHex, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config.js";
import { decryptPayload, payloadContext } from "./crypto.js";
import { db } from "./db/index.js";

/**
 * Onchain receipts. Each settled job gets a receipt of its public facts; receipts are hashed into
 * a Merkle tree and only the root is written to Robinhood Chain, so the chain reveals nothing
 * about any job. A party to a job gets its receipt and proof and can check them against the
 * transaction without trusting Liege.
 *
 * Hashing (SHA-256, domain-separated so a leaf can never pass as a node):
 *   leaf = sha256(0x00 || utf8(canonical(receipt)))
 *   node = sha256(0x01 || min(a, b) || max(a, b))   (pairs are sorted, so proofs need no sides)
 * An odd node at the end of a level moves up unchanged.
 * Transaction: 0 ETH from the anchor wallet to itself, input = utf8(ANCHOR_PREFIX) || root.
 */
export const ANCHOR_PREFIX = "LIEGE:RECEIPTS:v1";
export const MAX_BATCH = 512;
const RECEIPT_VERSION = 1;

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (value: Buffer) => `0x${value.toString("hex")}`;
const bytes = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex");

/** JSON with object keys sorted by code point at every level, so any language can reproduce it. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
};

export const leafHash = (receipt: unknown) =>
  hex(sha256(Buffer.from([0]), Buffer.from(canonicalJson(receipt), "utf8")));

// Postgres numerics arrive as strings; drop trailing zeros without going through a float.
const amount = (value: string | number | null | undefined) => {
  const text = String(value ?? "0");
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};

const pair = (a: Buffer, b: Buffer) =>
  Buffer.compare(a, b) <= 0 ? sha256(Buffer.from([1]), a, b) : sha256(Buffer.from([1]), b, a);

/** The root of `leaves` and, for each leaf, the sibling hashes from the leaf up to the root. */
export function merkleTree(leaves: string[]) {
  let level: Buffer[] = leaves.map(bytes);
  const proofs: string[][] = leaves.map(() => []);
  let positions = leaves.map((_, index) => index);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    positions = positions.map((position, leaf) => {
      const sibling = position ^ 1;
      if (sibling < level.length) proofs[leaf].push(hex(level[sibling]));
      return position >> 1;
    });
    level = next;
  }
  return { root: hex(level[0]), proofs };
}

export function verifyProof(leaf: string, proof: string[], root: string) {
  const computed = proof.reduce((node, sibling) => pair(node, bytes(sibling)), bytes(leaf));
  return hex(computed) === root.toLowerCase();
}

export const anchorData = (root: string) =>
  `${toHex(ANCHOR_PREFIX)}${root.replace(/^0x/, "")}` as Hex;

type Anchor = {
  address: string;
  send(data: Hex): Promise<Hex>;
  // Null while the transaction is still pending.
  confirm(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
};

const chain: Chain = {
  id: env.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
};

function chainAnchor(): Anchor | null {
  if (!env.RECEIPT_ANCHOR_PRIVATE_KEY) return null;
  const account = privateKeyToAccount(env.RECEIPT_ANCHOR_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, chain, transport: http(env.RHC_RPC_URL) });
  const reader = createPublicClient({ chain, transport: http(env.RHC_RPC_URL) });
  return {
    address: account.address,
    send: (data) => wallet.sendTransaction({ to: account.address, value: 0n, data }),
    async confirm(hash) {
      const receipt = await reader.getTransactionReceipt({ hash }).catch(() => null);
      return receipt ? { status: receipt.status, blockNumber: receipt.blockNumber } : null;
    },
  };
}

let anchorOverride: Anchor | null | undefined;
/** Tests replace the chain; production uses RECEIPT_ANCHOR_PRIVATE_KEY. */
export function useReceiptAnchor(anchor: Anchor | null | undefined) {
  anchorOverride = anchor;
}
const currentAnchor = () => (anchorOverride === undefined ? chainAnchor() : anchorOverride);

type SettledJob = {
  id: string;
  public_id: string;
  agent_id: string;
  status: "completed" | "rejected";
  escrow_mode: string;
  settlement_asset: string | null;
  budget_amount: string | null;
  budget_usdg: string;
  evaluator_fee_amount: string | null;
  evaluator_fee_usdg: string;
  funded_at: Date | null;
  submitted_at: Date | null;
  settled_at: Date;
  deliverable_ciphertext: string | null;
  veilora_settlement_tx_hash: string | null;
  signature?: string | null;
  signing_public_key?: string | null;
};

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

/** The public facts of a settled job. The deliverable appears only as its SHA-256. */
export function buildReceipt(job: SettledJob) {
  let deliverableSha256: string | null = null;
  if (job.deliverable_ciphertext)
    try {
      const deliverable = decryptPayload(
        job.deliverable_ciphertext,
        payloadContext(job.id, "deliverable"),
      );
      deliverableSha256 = hex(sha256(Buffer.from(deliverable, "utf8")));
    } catch {
      deliverableSha256 = null;
    }
  const asset = job.settlement_asset ?? "usdg";
  return {
    v: RECEIPT_VERSION,
    chainId: env.RHC_ID,
    jobId: job.id,
    job: job.public_id,
    agentId: job.agent_id,
    outcome: job.status,
    escrow: job.escrow_mode,
    asset,
    budget: amount(job.budget_amount ?? job.budget_usdg),
    evaluatorFee: amount(
      asset === "usdg"
        ? (job.evaluator_fee_usdg ?? job.evaluator_fee_amount)
        : job.evaluator_fee_amount,
    ),
    fundedAt: iso(job.funded_at),
    submittedAt: iso(job.submitted_at),
    settledAt: iso(job.settled_at),
    deliverableSha256,
    ...(job.veilora_settlement_tx_hash ? { settlementTx: job.veilora_settlement_tx_hash } : {}),
    // Present only for signed deliverables: Ed25519 over "liege-deliverable:v1:<jobId>:<deliverableSha256>".
    ...(job.signature && job.signing_public_key && deliverableSha256
      ? {
          deliverableSignature: {
            algorithm: "Ed25519",
            publicKey: job.signing_public_key,
            signature: job.signature,
          },
        }
      : {}),
  };
}

/** Writes a receipt for every settled job that has none yet. */
export async function createPendingReceipts(limit = 500) {
  const settled = await db.query<SettledJob>(
    `SELECT j.id, j.public_id, j.agent_id, j.status, j.escrow_mode, j.settlement_asset,
       j.budget_amount, j.budget_usdg, j.evaluator_fee_amount, j.evaluator_fee_usdg,
       j.funded_at, j.submitted_at, j.settled_at, j.veilora_settlement_tx_hash,
       s.deliverable_ciphertext, s.signature, s.signing_public_key
     FROM jobs j LEFT JOIN submissions s ON s.job_id = j.id
     WHERE j.status IN ('completed', 'rejected') AND j.settled_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM job_receipts r WHERE r.job_id = j.id)
     ORDER BY j.settled_at, j.id LIMIT $1`,
    [limit],
  );
  for (const job of settled.rows) {
    const receipt = buildReceipt(job);
    await db.query(
      "INSERT INTO job_receipts (job_id, receipt, leaf_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [job.id, JSON.stringify(receipt), leafHash(receipt)],
    );
  }
  return settled.rowCount ?? 0;
}

/** Confirms sent batches; a reverted or long-lost transaction releases its receipts for retry. */
async function confirmSentBatches(anchor: Anchor) {
  const sent = await db.query<{ id: string; tx_hash: Hex; sent_at: Date }>(
    "SELECT id, tx_hash, sent_at FROM receipt_batches WHERE status = 'sent' ORDER BY sent_at",
  );
  let confirmed = 0;
  for (const batch of sent.rows) {
    const result = await anchor.confirm(batch.tx_hash);
    const lost = !result && Date.now() - new Date(batch.sent_at).getTime() > 3_600_000;
    if (result?.status === "success") {
      await db.query(
        "UPDATE receipt_batches SET status='confirmed', block_number=$2, confirmed_at=now() WHERE id=$1",
        [batch.id, result.blockNumber.toString()],
      );
      confirmed++;
    } else if (result?.status === "reverted" || lost)
      await release(batch.id, result ? "reverted" : "not mined within an hour");
  }
  return confirmed;
}

async function release(batchId: string, error: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE job_receipts SET batch_id=NULL, leaf_index=NULL WHERE batch_id=$1", [
      batchId,
    ]);
    await client.query("UPDATE receipt_batches SET status='failed', error=$2 WHERE id=$1", [
      batchId,
      error,
    ]);
    await client.query("COMMIT");
  } catch (failure) {
    await client.query("ROLLBACK");
    throw failure;
  } finally {
    client.release();
  }
}

/**
 * Builds missing receipts, confirms earlier anchors, and anchors one new batch. A Postgres
 * advisory lock keeps the in-process timer and the cron route from anchoring the same receipts.
 */
export async function anchorReceipts() {
  const lock = await db.connect();
  try {
    const acquired = await lock.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('liege-receipt-anchor')) AS ok",
    );
    if (!acquired.rows[0].ok) return { status: "busy" as const };
    try {
      const created = await createPendingReceipts();
      const anchor = currentAnchor();
      if (!anchor) return { status: "disabled" as const, created };
      const confirmed = await confirmSentBatches(anchor);
      const pending = await db.query<{ job_id: string; leaf_hash: string }>(
        "SELECT job_id, leaf_hash FROM job_receipts WHERE batch_id IS NULL ORDER BY created_at, job_id LIMIT $1",
        [MAX_BATCH],
      );
      if (!pending.rowCount) return { status: "idle" as const, created, confirmed };
      const { root } = merkleTree(pending.rows.map((row) => row.leaf_hash));
      const batch = await db.query<{ id: string }>(
        `INSERT INTO receipt_batches (merkle_root, leaf_count, chain_id, anchor_address)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [root, pending.rowCount, env.RHC_ID, anchor.address.toLowerCase()],
      );
      const batchId = batch.rows[0].id;
      await db.query(
        `UPDATE job_receipts r SET batch_id=$1, leaf_index=p.position - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS p(job_id, position)
         WHERE r.job_id = p.job_id`,
        [batchId, pending.rows.map((row) => row.job_id)],
      );
      try {
        const txHash = await anchor.send(anchorData(root));
        await db.query(
          "UPDATE receipt_batches SET status='sent', tx_hash=$2, sent_at=now() WHERE id=$1",
          [batchId, txHash.toLowerCase()],
        );
        return {
          status: "anchored" as const,
          created,
          confirmed,
          batchId,
          root,
          txHash,
          receipts: pending.rowCount,
        };
      } catch (error) {
        await release(
          batchId,
          error instanceof Error ? error.message.slice(0, 500) : "send failed",
        );
        return { status: "failed" as const, created, confirmed, batchId };
      }
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('liege-receipt-anchor'))");
    }
  } finally {
    lock.release();
  }
}

/** A job's receipt, its proof, and where the root sits onchain. */
export async function receiptProof(jobId: string) {
  const found = await db.query<{
    receipt: Record<string, unknown>;
    leaf_hash: string;
    leaf_index: number | null;
    batch_id: string | null;
    merkle_root: string | null;
    status: string | null;
    chain_id: number | null;
    anchor_address: string | null;
    tx_hash: string | null;
    block_number: string | null;
    confirmed_at: Date | null;
  }>(
    `SELECT r.receipt, r.leaf_hash, r.leaf_index, r.batch_id, b.merkle_root, b.status, b.chain_id,
       b.anchor_address, b.tx_hash, b.block_number, b.confirmed_at
     FROM job_receipts r LEFT JOIN receipt_batches b ON b.id = r.batch_id WHERE r.job_id = $1`,
    [jobId],
  );
  const row = found.rows[0];
  if (!row) return null;
  let proof: string[] | null = null;
  if (row.batch_id) {
    const leaves = await db.query<{ leaf_hash: string }>(
      "SELECT leaf_hash FROM job_receipts WHERE batch_id=$1 ORDER BY leaf_index",
      [row.batch_id],
    );
    const tree = merkleTree(leaves.rows.map((leaf) => leaf.leaf_hash));
    proof = tree.proofs[row.leaf_index!];
  }
  return {
    receipt: row.receipt,
    leaf: row.leaf_hash,
    proof,
    anchor: row.batch_id
      ? {
          batchId: row.batch_id,
          status: row.status as "pending" | "sent" | "confirmed",
          merkleRoot: row.merkle_root!,
          chainId: row.chain_id!,
          anchorAddress: row.anchor_address,
          txHash: row.tx_hash,
          blockNumber: row.block_number ? Number(row.block_number) : null,
          confirmedAt: iso(row.confirmed_at),
          data: anchorData(row.merkle_root!),
        }
      : null,
    method: {
      leaf: "sha256(0x00 || utf8(receipt as JSON, no whitespace, object keys sorted by code point))",
      node: "sha256(0x01 || smaller hash || larger hash); an odd last node moves up unchanged",
      transaction: `a 0 ETH transaction from the anchor wallet to itself whose input is utf8("${ANCHOR_PREFIX}") followed by the 32-byte root`,
    },
  };
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
export function startReceiptAnchoring() {
  if (!env.RECEIPT_ANCHOR_INTERVAL_MS || timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void anchorReceipts()
      .catch((error) =>
        console.error(
          JSON.stringify({
            event: "receipts.anchor_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      .finally(() => {
        running = false;
      });
  }, env.RECEIPT_ANCHOR_INTERVAL_MS);
  timer.unref();
}
export function stopReceiptAnchoring() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
