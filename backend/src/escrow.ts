import type { Pool, PoolClient } from "pg";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseUnits,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "./config.js";
import { decryptEscrowPrivateKey, encryptEscrowPrivateKey } from "./crypto.js";
import { ApiError } from "./http.js";

type Queryable = Pool | PoolClient;
type EscrowWallet = { job_id: string; address: string; encrypted_private_key: string };
type FundingInput = { usdgTxHash: string; gasTxHash: string; quoteId: string };
const robinhoodChain: Chain = {
  id: env.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
};
const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(env.RHC_RPC_URL),
});
const usdg = () => {
  if (!env.USDG_TOKEN_ADDRESS)
    throw new ApiError(503, "onchain_escrow_unconfigured", "On-chain escrow is not configured.");
  return env.USDG_TOKEN_ADDRESS.toLowerCase() as Address;
};
const address = (value: string) => value.toLowerCase() as Address;
const hash = (value: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new ApiError(422, "invalid_transaction_hash", "A valid transaction hash is required.");
  return value.toLowerCase() as Hash;
};

export async function ensureEscrowWallet(client: Queryable, jobId: string) {
  const existing = await client.query<EscrowWallet>(
    "SELECT * FROM escrow_wallets WHERE job_id = $1",
    [jobId],
  );
  if (existing.rowCount) return { address: existing.rows[0].address };
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const created = await client.query<EscrowWallet>(
    "INSERT INTO escrow_wallets (job_id, address, encrypted_private_key) VALUES ($1,$2,$3) ON CONFLICT (job_id) DO UPDATE SET job_id = EXCLUDED.job_id RETURNING *",
    [jobId, account.address.toLowerCase(), encryptEscrowPrivateKey(privateKey, jobId)],
  );
  return { address: created.rows[0].address };
}

let cachedPrice: { value: number; expiresAt: number } | null = null;
async function ethUsdPrice() {
  if (cachedPrice && cachedPrice.expiresAt > Date.now()) return cachedPrice.value;
  const sources = [
    async () =>
      Number(
        (
          await (
            await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
              headers: { Accept: "application/json" },
            })
          ).json()
        ).data?.amount,
      ),
    async () =>
      Number(
        (
          await (
            await fetch(
              "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
              { headers: { Accept: "application/json" } },
            )
          ).json()
        ).ethereum?.usd,
      ),
  ];
  for (const source of sources) {
    try {
      const value = await source();
      if (Number.isFinite(value) && value > 0) {
        cachedPrice = { value, expiresAt: Date.now() + 60_000 };
        return value;
      }
    } catch {}
  }
  throw new ApiError(
    503,
    "eth_price_unavailable",
    "Could not obtain an ETH/USD quote. Try again shortly.",
  );
}

export async function createFundingQuote(client: Queryable, jobId: string) {
  const price = await ethUsdPrice();
  const eth = (env.ESCROW_GAS_RESERVE_USD / price).toFixed(18);
  const reserveWei = parseUnits(eth, 18);
  const expiresAt = new Date(Date.now() + env.ESCROW_QUOTE_TTL_SECONDS * 1000);
  const result = await client.query<{ id: string }>(
    "INSERT INTO escrow_funding_quotes (job_id, gas_reserve_wei, eth_usd_price, expires_at) VALUES ($1,$2,$3,$4) RETURNING id",
    [jobId, reserveWei.toString(), price, expiresAt],
  );
  return {
    quoteId: result.rows[0].id,
    gasReserveWei: reserveWei.toString(),
    ethUsdPrice: price,
    expiresAt,
  };
}

export async function verifyOnchainFunding(
  client: Queryable,
  input: FundingInput,
  expected: { jobId: string; clientAddress: string; budgetUsdg: string; evaluatorFeeUsdg: string },
) {
  const quote = await client.query<{ gas_reserve_wei: string; expires_at: Date }>(
    "SELECT gas_reserve_wei, expires_at FROM escrow_funding_quotes WHERE id = $1 AND job_id = $2",
    [input.quoteId, expected.jobId],
  );
  if (!quote.rowCount)
    throw new ApiError(
      422,
      "funding_quote_not_found",
      "This funding quote does not belong to this job.",
    );
  const wallet = await client.query<EscrowWallet>(
    "SELECT * FROM escrow_wallets WHERE job_id = $1",
    [expected.jobId],
  );
  if (!wallet.rowCount)
    throw new ApiError(
      409,
      "escrow_wallet_missing",
      "This job does not yet have an escrow wallet.",
    );
  const confirmedTransaction = async (transactionHash: Hash) => {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: env.ESCROW_CONFIRMATIONS,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return {
          receipt,
          transaction: await publicClient.getTransaction({ hash: transactionHash }),
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new ApiError(
      503,
      "rpc_transaction_indexing_delayed",
      "The chain confirmed your transfer, but the RPC has not indexed it yet. Retry funding with the same transaction hashes.",
    );
  };
  const [token, gas] = await Promise.all([
    confirmedTransaction(hash(input.usdgTxHash)),
    confirmedTransaction(hash(input.gasTxHash)),
  ]);
  const [tokenBlock, gasBlock] = await Promise.all([
    publicClient.getBlock({ blockNumber: token.receipt.blockNumber }),
    publicClient.getBlock({ blockNumber: gas.receipt.blockNumber }),
  ]);
  if (
    tokenBlock.timestamp * 1000n > BigInt(quote.rows[0].expires_at.getTime()) ||
    gasBlock.timestamp * 1000n > BigInt(quote.rows[0].expires_at.getTime())
  )
    throw new ApiError(
      422,
      "expired_funding_quote",
      "The deposits were mined after the gas-reserve quote expired. Contact support before retrying.",
    );
  const { receipt: tokenReceipt, transaction: tokenTx } = token;
  const { receipt: gasReceipt, transaction: gasTx } = gas;
  if (tokenReceipt.status !== "success" || gasReceipt.status !== "success")
    throw new ApiError(
      422,
      "funding_transaction_failed",
      "Both USDG and ETH reserve transfers must succeed.",
    );
  const clientAddress = address(expected.clientAddress),
    escrowAddress = address(wallet.rows[0].address);
  if (
    tokenTx.from.toLowerCase() !== clientAddress ||
    gasTx.from.toLowerCase() !== clientAddress ||
    gasTx.to?.toLowerCase() !== escrowAddress ||
    gasTx.value !== BigInt(quote.rows[0].gas_reserve_wei)
  )
    throw new ApiError(
      422,
      "invalid_funding_sender",
      "Funding transfers must come from the client wallet and use the quoted ETH reserve.",
    );
  const expectedRaw =
    parseUnits(expected.budgetUsdg, env.USDG_DECIMALS) +
    parseUnits(expected.evaluatorFeeUsdg, env.USDG_DECIMALS);
  const transfer = tokenReceipt.logs
    .map((log) => {
      try {
        return {
          address: log.address,
          decoded: decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics }),
        };
      } catch {
        return null;
      }
    })
    .find(
      (event) =>
        event?.decoded.eventName === "Transfer" &&
        event.address.toLowerCase() === usdg() &&
        event.decoded.args.from?.toLowerCase() === clientAddress &&
        event.decoded.args.to?.toLowerCase() === escrowAddress &&
        event.decoded.args.value === expectedRaw,
    );
  if (!transfer)
    throw new ApiError(
      422,
      "invalid_usdg_deposit",
      "The USDG transfer does not match this job escrow and amount.",
    );
  return {
    usdgTxHash: hash(input.usdgTxHash),
    gasTxHash: hash(input.gasTxHash),
    usdgAmountRaw: expectedRaw.toString(),
    gasAmountWei: quote.rows[0].gas_reserve_wei,
    escrowAddress: wallet.rows[0].address,
  };
}

export async function escrowSigner(client: Queryable, jobId: string) {
  const wallet = await client.query<EscrowWallet>(
    "SELECT * FROM escrow_wallets WHERE job_id = $1",
    [jobId],
  );
  if (!wallet.rowCount)
    throw new ApiError(409, "escrow_wallet_missing", "This job does not have an escrow wallet.");
  return privateKeyToAccount(
    decryptEscrowPrivateKey(wallet.rows[0].encrypted_private_key, jobId) as `0x${string}`,
  );
}

export type EscrowAsset = "usdg" | "eth";
// "pending" means mined but short of ESCROW_CONFIRMATIONS; null means no receipt is known.
export type ReceiptStatus = "success" | "reverted" | "pending" | null;

// The chain operations settlement needs, so tests can substitute an in-memory chain.
export interface EscrowChain {
  transactionCount(address: Address, blockTag: "latest" | "pending"): Promise<number>;
  // Signs without broadcasting. An amount of "all" sweeps the wallet's balance of that asset
  // (for ETH, net of gas); returns null when there is nothing to send.
  sign(
    account: LocalAccount,
    payout: { asset: EscrowAsset; to: Address; amount: bigint | "all"; nonce: number },
  ): Promise<{ raw: Hex; hash: Hash; amount: bigint } | null>;
  broadcast(raw: Hex): Promise<void>;
  receipt(hash: Hash): Promise<ReceiptStatus>;
  waitForReceipt(hash: Hash): Promise<ReceiptStatus>;
}

const walletClient = (account: LocalAccount) =>
  createWalletClient({ account, chain: robinhoodChain, transport: http(env.RHC_RPC_URL) });

async function signUsdgTransfer(
  account: LocalAccount,
  to: Address,
  amount: bigint | "all",
  nonce: number,
) {
  const value =
    amount === "all"
      ? await publicClient.readContract({
          address: usdg(),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        })
      : amount;
  if (value <= 0n) return null;
  const wallet = walletClient(account);
  const request = await wallet.prepareTransactionRequest({
    to: usdg(),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] }),
    nonce,
  });
  const raw = await wallet.signTransaction(request);
  return { raw, hash: keccak256(raw), amount: value };
}

async function signEthTransfer(
  account: LocalAccount,
  to: Address,
  amount: bigint | "all",
  nonce: number,
) {
  const balance = await publicClient.getBalance({ address: account.address });
  const gas = await publicClient.estimateGas({ account: account.address, to, value: 0n });
  const block = await publicClient.getBlock();
  const quotedGasPrice = await publicClient.getGasPrice();
  const gasPrice = block.baseFeePerGas
    ? quotedGasPrice > block.baseFeePerGas
      ? quotedGasPrice
      : block.baseFeePerGas + block.baseFeePerGas / 10n
    : quotedGasPrice;
  const value = amount === "all" ? balance - gas * gasPrice : amount;
  if (value <= 0n) return null;
  const raw = await walletClient(account).signTransaction({ to, value, gas, gasPrice, nonce });
  return { raw, hash: keccak256(raw), amount: value };
}

async function confirmedStatus(receipt: TransactionReceipt): Promise<ReceiptStatus> {
  const depth = (await publicClient.getBlockNumber()) - receipt.blockNumber + 1n;
  return depth < BigInt(env.ESCROW_CONFIRMATIONS) ? "pending" : receipt.status;
}

export const viemEscrowChain: EscrowChain = {
  transactionCount: (address, blockTag) => publicClient.getTransactionCount({ address, blockTag }),
  sign: (account, payout) =>
    payout.asset === "usdg"
      ? signUsdgTransfer(account, payout.to, payout.amount, payout.nonce)
      : signEthTransfer(account, payout.to, payout.amount, payout.nonce),
  async broadcast(raw) {
    await publicClient.sendRawTransaction({ serializedTransaction: raw });
  },
  async receipt(hash) {
    try {
      return await confirmedStatus(await publicClient.getTransactionReceipt({ hash }));
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  },
  async waitForReceipt(hash) {
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: env.ESCROW_CONFIRMATIONS,
        timeout: 60_000,
      });
      return receipt.status;
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) return null;
      throw error;
    }
  },
};
