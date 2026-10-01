import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError } from "./http.js";
import type { SettlementAsset } from "./assets.js";

type AccountKind = "available" | "escrow" | "stake" | "platform_clearing";

async function account(
  client: PoolClient,
  kind: AccountKind,
  options: { userId?: string; jobId?: string; asset?: SettlementAsset } = {},
) {
  const asset = options.asset ?? "usdg";
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM ledger_accounts WHERE kind = $1 AND asset = $4::text AND user_id IS NOT DISTINCT FROM $2::uuid AND job_id IS NOT DISTINCT FROM $3::uuid",
    [kind, options.userId ?? null, options.jobId ?? null, asset],
  );
  if (existing.rowCount) return existing.rows[0].id;
  const created = await client.query<{ id: string }>(
    "INSERT INTO ledger_accounts (kind, user_id, job_id, asset) VALUES ($1, $2::uuid, $3::uuid, $4::text) ON CONFLICT DO NOTHING RETURNING id",
    [kind, options.userId ?? null, options.jobId ?? null, asset],
  );
  if (created.rowCount) return created.rows[0].id;
  // A concurrent request created the same account first.
  return account(client, kind, options);
}

async function lockAccount(client: PoolClient, accountId: string) {
  const result = await client.query<{ kind: AccountKind }>(
    "SELECT kind FROM ledger_accounts WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "ledger_account_not_found", "The ledger account does not exist.");
  return result.rows[0].kind;
}

export async function balance(client: PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    "SELECT COALESCE(sum(amount), 0) AS balance FROM ledger_postings WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0].balance);
}

export async function userBalance(
  client: PoolClient,
  userId: string,
  kind: "available" | "stake" = "available",
  asset: SettlementAsset = "usdg",
) {
  const id = await account(client, kind, { userId, asset });
  return { accountId: id, amount: await balance(client, id) };
}

export async function transfer(
  client: PoolClient,
  input: {
    reference?: string;
    type: string;
    from: string;
    to: string;
    amount: number | string;
    createdBy?: string;
    metadata?: object;
    insufficientFunds?: ApiError;
    asset?: SettlementAsset;
  },
) {
  // Only the platform clearing account may go negative. The row lock serializes debits per
  // account until this transaction ends; the balance is read in a separate statement so that,
  // under READ COMMITTED, it includes any debit committed while this one waited for the lock.
  const asset = input.asset ?? "usdg";
  const decimals = asset === "usdg" ? 6 : 18;
  // JavaScript arithmetic can surface harmless binary tails such as
  // `0.30000000000000004` for `0.1 + 0.2`. Normalize only when the value is
  // within machine epsilon of the asset's supported precision; do not round a
  // caller-supplied value that genuinely has too many decimal places.
  const amount = (() => {
    if (typeof input.amount === "string") return input.amount.trim();
    const raw = String(input.amount);
    const fraction = raw.split(".")[1]?.length ?? 0;
    if (!raw.includes("e") && !raw.includes("E") && fraction <= decimals) return raw;
    const fixed = input.amount
      .toFixed(decimals)
      .replace(/\.0+$/, "")
      .replace(/(\.\d*?)0+$/, "$1");
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(input.amount)) * 16;
    return Math.abs(input.amount - Number(fixed)) <= tolerance ? fixed : raw;
  })();
  const amountPattern = new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${decimals}})?$`);
  if (!amountPattern.test(amount) || Number(amount) <= 0)
    throw new ApiError(422, "invalid_amount", "A ledger transfer amount must be positive.");
  if ((await lockAccount(client, input.from)) !== "platform_clearing") {
    const funded = await client.query<{ covered: boolean }>(
      "SELECT COALESCE(sum(amount), 0) >= $2::numeric AS covered FROM ledger_postings WHERE account_id = $1",
      [input.from, amount],
    );
    if (!funded.rows[0].covered)
      throw (
        input.insufficientFunds ??
        new ApiError(
          422,
          "insufficient_balance",
          "The source account balance cannot cover this transfer.",
        )
      );
  }
  const transaction = await client.query<{ id: string }>(
    "INSERT INTO ledger_transactions (reference, type, created_by, metadata) VALUES ($1,$2,$3,$4) RETURNING id",
    [
      input.reference ?? randomUUID(),
      input.type,
      input.createdBy ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await client.query(
    "INSERT INTO ledger_postings (transaction_id, account_id, amount, amount_usdg) VALUES ($1,$2,$3::numeric,CASE WHEN $6::text = 'usdg' THEN $3::numeric ELSE NULL END),($1,$4,$5::numeric,CASE WHEN $6::text = 'usdg' THEN $5::numeric ELSE NULL END)",
    [transaction.rows[0].id, input.from, `-${amount}`, input.to, amount, asset],
  );
  return transaction.rows[0].id;
}

export async function creditUser(
  client: PoolClient,
  userId: string,
  amount: number | string,
  createdBy: string,
  reference: string,
  metadata: object = {},
) {
  const platform = await account(client, "platform_clearing", { asset: "usdg" });
  const available = await account(client, "available", { userId, asset: "usdg" });
  return transfer(client, {
    reference,
    type: "admin_credit",
    from: platform,
    to: available,
    amount,
    createdBy,
    metadata,
  });
}

export async function setStake(
  client: PoolClient,
  userId: string,
  targetStake: number,
  createdBy: string,
  reference: string,
) {
  const available = await account(client, "available", { userId, asset: "usdg" });
  const stake = await account(client, "stake", { userId, asset: "usdg" });
  await lockAccount(client, stake);
  const current = await balance(client, stake);
  const difference = targetStake - current;
  if (difference > 0) {
    await transfer(client, {
      reference,
      type: "stake_lock",
      from: available,
      to: stake,
      amount: difference,
      createdBy,
      metadata: { userId, targetStake },
      insufficientFunds: new ApiError(
        422,
        "insufficient_available_balance",
        "The evaluator does not have enough available USDG to stake that amount.",
      ),
    });
  } else if (difference < 0)
    await transfer(client, {
      reference,
      type: "stake_unlock",
      from: stake,
      to: available,
      amount: -difference,
      createdBy,
      metadata: { userId, targetStake },
    });
  return targetStake;
}

export async function escrowAccount(
  client: PoolClient,
  jobId: string,
  asset: SettlementAsset = "usdg",
) {
  return account(client, "escrow", { jobId, asset });
}
