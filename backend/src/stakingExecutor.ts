import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  parseTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config.js";
import { db } from "./db/index.js";

const account = env.LIEGE_STAKING_POOL_PRIVATE_KEY
  ? privateKeyToAccount(env.LIEGE_STAKING_POOL_PRIVATE_KEY as Hex)
  : null;
const configuredAddress = env.LIEGE_STAKING_POOL_ADDRESS
  ? getAddress(env.LIEGE_STAKING_POOL_ADDRESS)
  : null;
const poolAddress =
  account && configuredAddress && configuredAddress !== account.address
    ? null
    : (account?.address ?? configuredAddress);
const chain = {
  id: env.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
} as const;
const client = createPublicClient({ chain, transport: http(env.RHC_RPC_URL) });
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
let active = false;

async function signRequested(id: string) {
  if (!account) return;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const result = await connection.query(
      "SELECT p.*,l.wallet_address FROM liege_staking_payouts p JOIN liege_staking_locks l ON l.id=p.lock_id WHERE p.id=$1 FOR UPDATE",
      [id],
    );
    const payout = result.rows[0];
    if (!payout || payout.status !== "requested") {
      await connection.query("COMMIT");
      return;
    }
    const [pendingNonce, gasPrice, outstanding] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      client.getGasPrice(),
      connection.query(
        "SELECT serialized_tx FROM liege_staking_payouts WHERE status IN ('signed','broadcast') AND serialized_tx IS NOT NULL AND id<>$1",
        [id],
      ),
    ]);
    const reservedNonces = outstanding.rows
      .map((item) => {
        try {
          return parseTransaction(item.serialized_tx as Hex).nonce;
        } catch {
          return null;
        }
      })
      .filter((nonce): nonce is number => typeof nonce === "number");
    const nonce = reservedNonces.reduce(
      (next, reserved) => Math.max(next, reserved + 1),
      pendingNonce,
    );
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(payout.wallet_address), BigInt(payout.amount)],
    });
    const raw = await account.signTransaction({
      to: getAddress(env.LIEGE_TOKEN_ADDRESS),
      data,
      nonce,
      gas: 100_000n,
      gasPrice,
      chainId: env.RHC_ID,
    });
    await connection.query(
      "UPDATE liege_staking_payouts SET status='signed',serialized_tx=$2,tx_nonce=$3,tx_hash=$4,updated_at=now() WHERE id=$1",
      [id, raw, nonce, keccak256(raw)],
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function processPayout(id: string, status: string, raw: Hex | null, txHash: Hex | null) {
  if (status === "requested") {
    await signRequested(id);
    return;
  }
  if (status === "signed" && raw && txHash) {
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (error) {
      if (
        !/already known|known transaction|already imported/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
    }
    await db.query(
      "UPDATE liege_staking_payouts SET status='broadcast',updated_at=now() WHERE id=$1 AND status='signed'",
      [id],
    );
    return;
  }
  if (status !== "broadcast" || !txHash) return;
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) return;
    if (!raw) return;
    let transactionKnown = true;
    try {
      await client.getTransaction({ hash: txHash });
    } catch (lookupError) {
      transactionKnown = !(lookupError instanceof TransactionNotFoundError);
    }
    if (transactionKnown) return;
    const nonce = parseTransaction(raw).nonce;
    if (nonce === null || nonce === undefined) return;
    const latestNonce = await client.getTransactionCount({
      address: account!.address,
      blockTag: "latest",
    });
    if (latestNonce > nonce) {
      await db.query(
        "UPDATE liege_staking_payouts SET status='failed',failure_reason='Transaction nonce was used elsewhere; no matching payout receipt exists. Retry the claim to sign a fresh transaction.',updated_at=now() WHERE id=$1 AND status='broadcast' AND tx_hash=$2 AND updated_at < now()-interval '10 minutes'",
        [id, txHash],
      );
      return;
    }
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (broadcastError) {
      if (
        !/already known|known transaction|already imported/i.test(
          broadcastError instanceof Error ? broadcastError.message : String(broadcastError),
        )
      )
        throw broadcastError;
    }
    return;
  }
  if (receipt.status !== "success") {
    await db.query(
      "UPDATE liege_staking_payouts SET status='failed',failure_reason='Payout transfer reverted on chain.',updated_at=now() WHERE id=$1 AND status='broadcast'",
      [id],
    );
    return;
  }
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(env.LIEGE_STAKING_CONFIRMATIONS)) return;
  const row = await db.query(
    "SELECT p.amount,l.wallet_address FROM liege_staking_payouts p JOIN liege_staking_locks l ON l.id=p.lock_id WHERE p.id=$1",
    [id],
  );
  const amount = BigInt(row.rows[0].amount);
  const wallet = getAddress(row.rows[0].wallet_address);
  const matches = receipt.logs.filter((log) => {
    if (getAddress(log.address) !== getAddress(env.LIEGE_TOKEN_ADDRESS)) return false;
    try {
      const event = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      const args = event.args as { from: Address; to: Address; value: bigint };
      return (
        getAddress(args.from) === account?.address &&
        getAddress(args.to) === wallet &&
        args.value === amount
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1)
    throw new Error(`Staking payout ${id} receipt did not contain the expected LIEGE transfer.`);
  await db.query(
    "UPDATE liege_staking_payouts SET status='confirmed',confirmed_at=now(),updated_at=now() WHERE id=$1 AND status='broadcast'",
    [id],
  );
}

export async function runLiegeStakingPayouts() {
  if (active || !account || !poolAddress) return;
  active = true;
  const connection = await db.connect();
  let locked = false;
  try {
    locked = Boolean(
      (
        await connection.query(
          "SELECT pg_try_advisory_lock(hashtext('liege_staking_payout_executor')) AS locked",
        )
      ).rows[0]?.locked,
    );
    if (!locked) return;
    const pending = await connection.query(
      "SELECT id,status,serialized_tx,tx_hash FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast') ORDER BY created_at LIMIT 10",
    );
    for (const row of pending.rows) {
      try {
        await processPayout(
          row.id,
          row.status,
          row.serialized_tx as Hex | null,
          row.tx_hash as Hex | null,
        );
      } catch (error) {
        console.error(
          "Liege staking payout processing failed",
          row.id,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.error("Liege staking payout cycle failed", error);
  } finally {
    if (locked)
      await connection
        .query("SELECT pg_advisory_unlock(hashtext('liege_staking_payout_executor'))")
        .catch(() => {});
    connection.release();
    active = false;
  }
}

export function startLiegeStakingPayoutExecutor() {
  if (!account) return;
  void runLiegeStakingPayouts();
  setInterval(() => void runLiegeStakingPayouts(), 15_000).unref();
}
