import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import type { SettlementAsset } from "./assets.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { creditTopup } from "./ledger.js";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const client = createPublicClient({
  chain: {
    id: env.RHC_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
  },
  transport: http(env.RHC_RPC_URL),
});

type Log = { address: string; data: Hex; topics: [Hex, ...Hex[]] | [] };

/** The chain reads a top-up needs; tests replace them. */
export const topupChain = {
  receipt: (hash: Hex) =>
    client.getTransactionReceipt({ hash }) as Promise<{
      status: "success" | "reverted";
      blockNumber: bigint;
      logs: Log[];
    }>,
  head: () => client.getBlockNumber(),
};

export function topupTokens() {
  return {
    usdg: env.USDG_TOKEN_ADDRESS
      ? { address: env.USDG_TOKEN_ADDRESS, decimals: env.USDG_DECIMALS }
      : null,
    liege: { address: env.LIEGE_TOKEN_ADDRESS, decimals: env.LIEGE_DECIMALS },
  } satisfies Record<SettlementAsset, { address: string; decimals: number } | null>;
}

/**
 * Credits a top-up: the transaction must have succeeded with enough confirmations and transfer
 * the asset's token from the signed-in wallet to the top-up address. Every matching transfer in
 * it counts, and a transaction is credited once, to the wallet that sent it.
 */
export async function claimTopup(input: {
  userId: string;
  wallet: string;
  txHash: string;
  asset: SettlementAsset;
}) {
  if (!env.TOPUP_ADDRESS)
    throw new ApiError(503, "topups_unavailable", "Top-ups are not configured yet.");
  const token = topupTokens()[input.asset];
  if (!token)
    throw new ApiError(
      503,
      "topups_unavailable",
      `${input.asset.toUpperCase()} top-ups are not configured.`,
    );
  const hash = input.txHash.toLowerCase() as Hex;
  const earlier = await db.query<{ user_id: string }>(
    "SELECT user_id FROM ledger_topups WHERE tx_hash = $1",
    [hash],
  );
  if (earlier.rowCount) {
    if (earlier.rows[0].user_id !== input.userId)
      throw new ApiError(409, "topup_already_used", "This transaction was already credited.");
    return { ...(await topupRow(hash)), alreadyCredited: true };
  }
  let receipt;
  try {
    receipt = await topupChain.receipt(hash);
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError)
      throw new ApiError(202, "awaiting_receipt", "The transfer has not been indexed yet.");
    throw error;
  }
  if (receipt.status !== "success")
    throw new ApiError(422, "topup_failed", "The transfer did not succeed onchain.");
  const head = await topupChain.head();
  if (head - receipt.blockNumber + 1n < BigInt(env.TOPUP_CONFIRMATIONS))
    throw new ApiError(202, "awaiting_confirmations", "The transfer is waiting for confirmations.");
  const from = getAddress(input.wallet);
  const to = getAddress(env.TOPUP_ADDRESS);
  let raw = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token.address)) continue;
    try {
      const event = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      const args = event.args as { from: string; to: string; value: bigint };
      if (getAddress(args.from) === from && getAddress(args.to) === to) raw += args.value;
    } catch {
      // Not a Transfer event.
    }
  }
  if (raw <= 0n)
    throw new ApiError(
      422,
      "topup_not_found",
      `The transaction has no ${input.asset.toUpperCase()} transfer from your wallet to the Liege top-up address.`,
    );
  const amount = formatUnits(raw, token.decimals);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const ledgerTransactionId = await creditTopup(tx, {
      userId: input.userId,
      amount,
      asset: input.asset,
      txHash: hash,
    });
    await tx.query(
      `INSERT INTO ledger_topups (tx_hash, user_id, wallet_address, asset, amount, amount_raw,
         block_number, ledger_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        hash,
        input.userId,
        from.toLowerCase(),
        input.asset,
        amount,
        raw.toString(),
        receipt.blockNumber.toString(),
        ledgerTransactionId,
      ],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    // Two claims of the same transaction at once: the other one credited it.
    if ((error as { code?: string }).code === "23505")
      return { ...(await topupRow(hash)), alreadyCredited: true };
    throw error;
  } finally {
    tx.release();
  }
  return { ...(await topupRow(hash)), alreadyCredited: false };
}

async function topupRow(hash: string) {
  const row = await db.query(
    `SELECT tx_hash, asset, trim_scale(amount)::text AS amount, block_number::text, created_at
     FROM ledger_topups WHERE tx_hash = $1`,
    [hash],
  );
  return row.rows[0];
}
