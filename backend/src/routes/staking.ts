import { Router } from "express";
import { z } from "zod";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  TransactionReceiptNotFoundError,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { asyncRoute, ApiError } from "../http.js";
import { env } from "../config.js";
import { db } from "../db/index.js";
import {
  isLiegeStakeMature,
  isLiegeStakingTerm,
  liegeStakingReward,
  LIEGE_STAKING_TIERS,
} from "../staking.js";

export const stakingRouter = Router();
const chain = {
  id: env.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RHC_RPC_URL] } },
} as const;
const publicClient = createPublicClient({ chain, transport: http(env.RHC_RPC_URL) });
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const configuredPoolAddress = (): Address | null => {
  if (env.LIEGE_STAKING_POOL_PRIVATE_KEY) {
    const derived = privateKeyToAccount(env.LIEGE_STAKING_POOL_PRIVATE_KEY as Hex).address;
    if (env.LIEGE_STAKING_POOL_ADDRESS && getAddress(env.LIEGE_STAKING_POOL_ADDRESS) !== derived)
      throw new ApiError(
        503,
        "staking_pool_mismatch",
        "Configured staking pool address does not match its signing key.",
      );
    return derived;
  }
  return env.LIEGE_STAKING_POOL_ADDRESS ? getAddress(env.LIEGE_STAKING_POOL_ADDRESS) : null;
};
const positiveRaw = z.string().regex(/^[1-9]\d{0,77}$/);
const txHashSchema = z.string().regex(/^0x[\da-fA-F]{64}$/);
const walletSchema = z.string().regex(/^0x[\da-fA-F]{40}$/);

stakingRouter.get(
  "/config",
  asyncRoute(async (_req, res) => {
    const poolAddress = configuredPoolAddress();
    let poolBalance = "0";
    let poolEthBalance = "0";
    const liabilities = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(principal_amount+reward_amount),0)::text AS amount FROM liege_staking_locks WHERE status='locked'
     UNION ALL SELECT COALESCE(SUM(amount),0)::text FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast','failed')`,
    );
    const poolLiabilities = liabilities.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (poolAddress) {
      poolBalance = (
        await publicClient.readContract({
          address: getAddress(env.LIEGE_TOKEN_ADDRESS),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [poolAddress],
        })
      ).toString();
      poolEthBalance = (await publicClient.getBalance({ address: poolAddress })).toString();
    }
    res.json({
      data: {
        enabled:
          env.LIEGE_STAKING_ENABLED === "true" &&
          Boolean(poolAddress && env.LIEGE_STAKING_POOL_PRIVATE_KEY),
        chainId: env.RHC_ID,
        token: {
          symbol: "LIEGE",
          address: getAddress(env.LIEGE_TOKEN_ADDRESS),
          decimals: env.LIEGE_DECIMALS,
        },
        poolAddress,
        poolBalance,
        poolEthBalance,
        poolLiabilities: poolLiabilities.toString(),
        poolSurplus: (BigInt(poolBalance) - poolLiabilities).toString(),
        confirmations: env.LIEGE_STAKING_CONFIRMATIONS,
        payoutEnabled: Boolean(poolAddress && env.LIEGE_STAKING_POOL_PRIVATE_KEY),
        terms: Object.values(LIEGE_STAKING_TIERS),
      },
    });
  }),
);

stakingRouter.post(
  "/prepare",
  asyncRoute(async (req, res) => {
    const { amount, termDays } = z
      .object({ amount: positiveRaw, termDays: z.coerce.number().int() })
      .parse(req.body);
    if (!isLiegeStakingTerm(termDays))
      throw new ApiError(422, "invalid_staking_term", "Choose a 30, 45, or 90 day term.");
    const poolAddress = configuredPoolAddress();
    if (env.LIEGE_STAKING_ENABLED !== "true" || !poolAddress || !env.LIEGE_STAKING_POOL_PRIVATE_KEY)
      throw new ApiError(
        503,
        "staking_unavailable",
        "Staking deposits are paused or the pool address and payout signer are not configured.",
      );
    const term = LIEGE_STAKING_TIERS[termDays];
    const principal = BigInt(amount);
    const reward = liegeStakingReward(principal, term.days, term.apyBps);
    const [poolBalance, outstanding] = await Promise.all([
      publicClient.readContract({
        address: getAddress(env.LIEGE_TOKEN_ADDRESS),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [poolAddress],
      }),
      db.query<{ amount: string }>(
        `SELECT COALESCE(SUM(principal_amount+reward_amount),0)::text AS amount FROM liege_staking_locks WHERE status='locked'
         UNION ALL SELECT COALESCE(SUM(amount),0)::text FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast','failed')`,
      ),
    ]);
    const liabilities = outstanding.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (poolBalance < liabilities + reward)
      throw new ApiError(
        422,
        "pool_reserve_shortfall",
        "Pool reserves cannot cover this position's projected reward. No deposit transaction was prepared.",
      );
    res.json({
      data: {
        transaction: {
          to: getAddress(env.LIEGE_TOKEN_ADDRESS),
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [poolAddress, principal],
          }),
          value: "0x0",
          chainId: env.RHC_ID,
        },
        poolAddress,
        amount,
        termDays,
        apyBps: term.apyBps,
        rewardAmount: reward.toString(),
        totalReturn: (principal + reward).toString(),
      },
    });
  }),
);

stakingRouter.post(
  "/locks",
  asyncRoute(async (req, res) => {
    const input = z
      .object({
        walletAddress: walletSchema,
        txHash: txHashSchema,
        amount: positiveRaw,
        termDays: z.coerce.number().int(),
      })
      .parse(req.body);
    if (!isLiegeStakingTerm(input.termDays))
      throw new ApiError(422, "invalid_staking_term", "Choose a 30, 45, or 90 day term.");
    const poolAddress = configuredPoolAddress();
    if (env.LIEGE_STAKING_ENABLED !== "true" || !poolAddress || !env.LIEGE_STAKING_POOL_PRIVATE_KEY)
      throw new ApiError(
        503,
        "staking_unavailable",
        "Staking deposits are paused or the pool address and payout signer are not configured.",
      );
    const wallet = getAddress(input.walletAddress),
      hash = input.txHash as Hex;
    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError)
        throw new ApiError(
          202,
          "awaiting_receipt",
          "Deposit transaction has not been indexed yet.",
        );
      throw error;
    }
    if (receipt.status !== "success")
      throw new ApiError(422, "deposit_failed", "The token transfer did not succeed.");
    const head = await publicClient.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(env.LIEGE_STAKING_CONFIRMATIONS))
      throw new ApiError(
        202,
        "awaiting_confirmations",
        "Deposit is waiting for chain confirmations.",
      );
    const matching: bigint[] = [];
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(env.LIEGE_TOKEN_ADDRESS)) continue;
      try {
        const event = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
        const args = event.args as { from: Address; to: Address; value: bigint };
        if (getAddress(args.from) === wallet && getAddress(args.to) === poolAddress)
          matching.push(args.value);
      } catch {
        /* ignore other token events */
      }
    }
    if (matching.length !== 1 || matching[0] !== BigInt(input.amount))
      throw new ApiError(
        422,
        "deposit_mismatch",
        "Transaction must contain exactly one matching LIEGE transfer to the staking pool.",
      );
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const tier = LIEGE_STAKING_TIERS[input.termDays];
    const reward = liegeStakingReward(matching[0], tier.days, tier.apyBps);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('liege_staking_pool'))");
      const existing = await client.query(
        "SELECT * FROM liege_staking_locks WHERE deposit_tx_hash=$1",
        [hash],
      );
      if (existing.rowCount) {
        const credited = existing.rows[0];
        if (
          getAddress(credited.wallet_address) !== wallet ||
          Number(credited.term_days) !== input.termDays ||
          BigInt(credited.principal_amount) !== BigInt(input.amount)
        )
          throw new ApiError(
            409,
            "deposit_already_used",
            "This transaction has already been credited to a different staking position.",
          );
        await client.query("COMMIT");
        res.json({ data: { lock: credited, alreadyCredited: true } });
        return;
      }
      const liabilities = await client.query<{ amount: string }>(
        `SELECT COALESCE(SUM(principal_amount + reward_amount),0)::text AS amount FROM liege_staking_locks WHERE status='locked' UNION ALL SELECT COALESCE(SUM(amount),0)::text FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast','failed')`,
      );
      const owed = liabilities.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const poolBalance = await publicClient.readContract({
        address: getAddress(env.LIEGE_TOKEN_ADDRESS),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [poolAddress],
      });
      if (poolBalance < owed + matching[0] + reward)
        throw new ApiError(
          422,
          "pool_reserve_shortfall",
          "Pool reserves cannot cover existing obligations and this lock's guaranteed reward.",
        );
      const inserted = await client.query(
        `INSERT INTO liege_staking_locks(wallet_address,term_days,apy_bps,principal_amount,reward_amount,starts_at,unlocks_at,deposit_tx_hash)
       VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),$8) RETURNING *`,
        [
          wallet,
          tier.days,
          tier.apyBps,
          matching[0].toString(),
          reward.toString(),
          Number(block.timestamp),
          Number(block.timestamp) + tier.days * 86400,
          hash,
        ],
      );
      await client.query("COMMIT");
      res.status(201).json({ data: { lock: inserted.rows[0], alreadyCredited: false } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

stakingRouter.get(
  "/locks/:walletAddress",
  asyncRoute(async (req, res) => {
    const wallet = walletSchema.parse(req.params.walletAddress);
    const result = await db.query(
      "SELECT * FROM liege_staking_locks WHERE lower(wallet_address)=lower($1) ORDER BY created_at DESC",
      [wallet],
    );
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    res.json({
      data: {
        locks: result.rows.map((row) => {
          const unlocksAt = Math.floor(new Date(row.unlocks_at).getTime() / 1000);
          return {
            ...row,
            effectiveStatus:
              row.status === "claimed"
                ? "claimed"
                : isLiegeStakeMature(unlocksAt, chainNow)
                  ? "matured"
                  : "locked",
            secondsRemaining: Math.max(0, unlocksAt - chainNow),
          };
        }),
      },
    });
  }),
);

stakingRouter.get(
  "/payouts/:walletAddress",
  asyncRoute(async (req, res) => {
    const wallet = walletSchema.parse(req.params.walletAddress);
    const result = await db.query(
      "SELECT id,lock_id,amount,status,tx_hash,failure_reason,created_at,updated_at,confirmed_at FROM liege_staking_payouts WHERE lower(wallet_address)=lower($1) ORDER BY created_at DESC",
      [wallet],
    );
    res.json({ data: { payouts: result.rows } });
  }),
);

stakingRouter.post(
  "/locks/:lockId/claim-message",
  asyncRoute(async (req, res) => {
    const { walletAddress } = z.object({ walletAddress: walletSchema }).parse(req.body);
    const found = await db.query(
      "SELECT * FROM liege_staking_locks WHERE id=$1 AND lower(wallet_address)=lower($2)",
      [req.params.lockId, walletAddress],
    );
    const lock = found.rows[0];
    if (!lock)
      throw new ApiError(404, "stake_not_claimable", "No active lock was found for this wallet.");
    if (lock.status !== "locked") {
      const previous = await db.query("SELECT status FROM liege_staking_payouts WHERE lock_id=$1", [
        lock.id,
      ]);
      if (previous.rows[0]?.status !== "failed")
        throw new ApiError(
          409,
          "stake_already_claimed",
          "This position already has a payout in progress or has been paid.",
        );
    }
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    if (!isLiegeStakeMature(Math.floor(new Date(lock.unlocks_at).getTime() / 1000), chainNow))
      throw new ApiError(409, "stake_locked", "This position cannot be withdrawn before maturity.");
    const amount = BigInt(lock.principal_amount) + BigInt(lock.reward_amount);
    res.json({
      data: {
        message: `Liege staking claim\nLock: ${lock.id}\nWallet: ${getAddress(walletAddress)}\nAmount: ${amount}\nToken: ${getAddress(env.LIEGE_TOKEN_ADDRESS)}\nChain ID: ${env.RHC_ID}`,
      },
    });
  }),
);

stakingRouter.post(
  "/locks/:lockId/claim",
  asyncRoute(async (req, res) => {
    const { walletAddress, signature } = z
      .object({ walletAddress: walletSchema, signature: z.string().regex(/^0x[\da-fA-F]+$/) })
      .parse(req.body);
    const wallet = getAddress(walletAddress);
    const found = await db.query(
      "SELECT * FROM liege_staking_locks WHERE id=$1 AND lower(wallet_address)=lower($2)",
      [req.params.lockId, wallet],
    );
    const lock = found.rows[0];
    if (!lock) throw new ApiError(404, "stake_not_found", "Staking position not found.");
    const total = BigInt(lock.principal_amount) + BigInt(lock.reward_amount);
    const message = `Liege staking claim\nLock: ${lock.id}\nWallet: ${wallet}\nAmount: ${total}\nToken: ${getAddress(env.LIEGE_TOKEN_ADDRESS)}\nChain ID: ${env.RHC_ID}`;
    if (!(await verifyMessage({ address: wallet, message, signature: signature as Hex })))
      throw new ApiError(401, "invalid_claim_signature", "Wallet signature could not be verified.");
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    if (!isLiegeStakeMature(Math.floor(new Date(lock.unlocks_at).getTime() / 1000), chainNow))
      throw new ApiError(409, "stake_locked", "This position cannot be withdrawn before maturity.");
    if (!env.LIEGE_STAKING_POOL_PRIVATE_KEY)
      throw new ApiError(
        503,
        "staking_payout_unavailable",
        "Pool payout signing is not configured yet.",
      );
    const client = await db.connect();
    let payoutId: string;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('liege_staking_pool'))");
      const current = await client.query(
        "SELECT * FROM liege_staking_locks WHERE id=$1 FOR UPDATE",
        [lock.id],
      );
      if (current.rows[0].status === "claimed") {
        const previous = await client.query(
          "SELECT id,status FROM liege_staking_payouts WHERE lock_id=$1 FOR UPDATE",
          [lock.id],
        );
        if (!previous.rowCount)
          throw new ApiError(
            409,
            "stake_already_claimed",
            "This position has already been claimed.",
          );
        if (previous.rows[0].status === "failed") {
          const balance = await publicClient.readContract({
            address: getAddress(env.LIEGE_TOKEN_ADDRESS),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [configuredPoolAddress()!],
          });
          const reserves = await client.query<{ amount: string }>(
            "SELECT COALESCE(SUM(principal_amount+reward_amount),0)::text AS amount FROM liege_staking_locks WHERE status='locked' UNION ALL SELECT COALESCE(SUM(amount),0)::text FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast','failed')",
          );
          const owed = reserves.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
          if (balance < owed)
            throw new ApiError(
              409,
              "pool_insolvent",
              "Pool reserve check failed; payout was not retried.",
            );
          await client.query(
            "UPDATE liege_staking_payouts SET status='requested',serialized_tx=NULL,tx_nonce=NULL,tx_hash=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1",
            [previous.rows[0].id],
          );
        }
        payoutId = previous.rows[0].id;
        await client.query("COMMIT");
        res.status(202).json({
          data: {
            payoutId,
            status: previous.rows[0].status === "failed" ? "requested" : previous.rows[0].status,
            message: "Claim payout is queued or already being processed.",
          },
        });
        return;
      }
      const balance = await publicClient.readContract({
        address: getAddress(env.LIEGE_TOKEN_ADDRESS),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [configuredPoolAddress()!],
      });
      const liabilities = await client.query<{ amount: string }>(
        "SELECT COALESCE(SUM(principal_amount+reward_amount),0)::text AS amount FROM liege_staking_locks WHERE status='locked' UNION ALL SELECT COALESCE(SUM(amount),0)::text FROM liege_staking_payouts WHERE status IN ('requested','signed','broadcast','failed')",
      );
      const owed = liabilities.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      if (balance < owed)
        throw new ApiError(
          409,
          "pool_insolvent",
          "Pool reserve check failed; no payout was initiated.",
        );
      const result = await client.query(
        "INSERT INTO liege_staking_payouts(lock_id,wallet_address,amount) VALUES($1,$2,$3) RETURNING id",
        [lock.id, wallet, total.toString()],
      );
      payoutId = result.rows[0].id;
      await client.query(
        "UPDATE liege_staking_locks SET status='claimed',claimed_at=now() WHERE id=$1",
        [lock.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.status(202).json({
      data: {
        payoutId,
        status: "requested",
        message: "Claim accepted; payout is being processed.",
      },
    });
  }),
);
