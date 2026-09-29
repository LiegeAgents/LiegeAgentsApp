import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError } from "./http.js";

type AccountKind = "available" | "escrow" | "stake" | "platform_clearing";

async function account(
  client: PoolClient,
  kind: AccountKind,
  options: { userId?: string; jobId?: string } = {},
) {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM ledger_accounts WHERE kind = $1 AND user_id IS NOT DISTINCT FROM $2 AND job_id IS NOT DISTINCT FROM $3",
    [kind, options.userId ?? null, options.jobId ?? null],
  );
  if (existing.rowCount) return existing.rows[0].id;
  const created = await client.query<{ id: string }>(
    "INSERT INTO ledger_accounts (kind, user_id, job_id) VALUES ($1, $2, $3) RETURNING id",
    [kind, options.userId ?? null, options.jobId ?? null],
  );
  return created.rows[0].id;
}

export async function balance(client: PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    "SELECT COALESCE(sum(amount_usdg), 0) AS balance FROM ledger_postings WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0].balance);
}

export async function userBalance(
  client: PoolClient,
  userId: string,
  kind: "available" | "stake" = "available",
) {
  const id = await account(client, kind, { userId });
  return { accountId: id, amount: await balance(client, id) };
}

export async function transfer(
  client: PoolClient,
  input: {
    reference?: string;
    type: string;
    from: string;
    to: string;
    amount: number;
    createdBy?: string;
    metadata?: object;
  },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    throw new ApiError(422, "invalid_amount", "A ledger transfer amount must be positive.");
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
    "INSERT INTO ledger_postings (transaction_id, account_id, amount_usdg) VALUES ($1,$2,$3),($1,$4,$5)",
    [transaction.rows[0].id, input.from, -input.amount, input.to, input.amount],
  );
  return transaction.rows[0].id;
}

export async function creditUser(
  client: PoolClient,
  userId: string,
  amount: number,
  createdBy: string,
  reference: string,
  metadata: object = {},
) {
  const platform = await account(client, "platform_clearing");
  const available = await account(client, "available", { userId });
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
  const available = await account(client, "available", { userId });
  const stake = await account(client, "stake", { userId });
  const current = await balance(client, stake);
  const difference = targetStake - current;
  if (difference > 0) {
    if ((await balance(client, available)) < difference)
      throw new ApiError(
        422,
        "insufficient_available_balance",
        "The evaluator does not have enough available USDG to stake that amount.",
      );
    await transfer(client, {
      reference,
      type: "stake_lock",
      from: available,
      to: stake,
      amount: difference,
      createdBy,
      metadata: { userId, targetStake },
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

export async function escrowAccount(client: PoolClient, jobId: string) {
  return account(client, "escrow", { jobId });
}
