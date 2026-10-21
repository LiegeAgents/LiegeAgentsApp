import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { assetLabel, type SettlementAsset } from "./assets.js";
import { env } from "./config.js";
import { decryptPayload, encryptPayload, payloadContext } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { callAccounts, transfer } from "./ledger.js";
import { readyEnrollment } from "./superAgentEnrollment.js";
import { callTransport } from "./superAgentProbe.js";

/**
 * Pay-per-call: a small request answered while the client waits, with no escrow and no evaluator.
 * The price moves from the client's available balance to their held account before the agent is
 * called, then to the agent's owner when the runtime answers with a valid proof, or back to the
 * client on anything else. A call never ends with the money in held.
 */
export const MAX_CALL_INPUT = 8_000;
export const MAX_CALL_OUTPUT = 100_000;

export type CallRow = {
  id: string;
  client_id: string;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  service_slug: string;
  settlement_asset: SettlementAsset;
  price: string;
  status: "pending" | "succeeded" | "refunded";
  idempotency_key: string | null;
  input_ciphertext: string;
  output_ciphertext: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
};

// trim_scale keeps amounts in each asset's precision: 0.25, never 0.250000000000000000.
export const callColumns = `c.*, trim_scale(c.price)::text AS price, a.name AS agent_name, a.owner_id`;

export const callProof = (secret: string, callId: string, output: string) =>
  createHmac("sha256", secret)
    .update(`superagent.call:${callId}:${createHash("sha256").update(output).digest("hex")}`)
    .digest("hex");

export function callPriceCap(asset: SettlementAsset) {
  return asset === "liege" ? env.INSTANT_CALL_MAX_LIEGE : env.INSTANT_CALL_MAX_USDG;
}

/** The client's view: their input and the answer. Owners see the call without either. */
export function presentCall(row: CallRow, viewerId: string) {
  const client = row.client_id === viewerId;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    serviceSlug: row.service_slug,
    settlementAsset: row.settlement_asset,
    price: row.price,
    status: row.status,
    charged: row.status === "succeeded",
    role: client ? "client" : "agent_owner",
    input: client
      ? decryptPayload(row.input_ciphertext, payloadContext(row.id, "call-input"))
      : null,
    output:
      client && row.output_ciphertext
        ? decryptPayload(row.output_ciphertext, payloadContext(row.id, "call-output"))
        : null,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function loadCall(id: string, viewerId: string) {
  const result = await db.query<CallRow>(
    `SELECT ${callColumns} FROM superagent_calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND (c.client_id = $2 OR a.owner_id = $2)`,
    [id, viewerId],
  );
  return result.rows[0] ?? null;
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Target = {
  owner_id: string;
  service_slug: string;
  webhook_id: string;
  url: string;
  secret_ciphertext: string;
  price: string | null;
  assets: string[];
};

/** Holds the price and records the call. Returns an earlier call for a repeated idempotency key. */
async function openCall(input: {
  clientId: string;
  agentId: string;
  request: string;
  asset: SettlementAsset;
  idempotencyKey?: string;
}) {
  return inTransaction(async (client) => {
    if (input.idempotencyKey) {
      const earlier = await client.query<{ id: string }>(
        "SELECT id FROM superagent_calls WHERE client_id = $1 AND idempotency_key = $2",
        [input.clientId, input.idempotencyKey],
      );
      if (earlier.rowCount) return { id: earlier.rows[0].id, replay: true as const };
    }
    const priceColumn = input.asset === "liege" ? "e.call_price_liege" : "e.call_price_usdg";
    const found = await client.query<Target>(
      `SELECT a.owner_id, s.slug AS service_slug, w.id AS webhook_id, w.url, w.secret_ciphertext,
         trim_scale(${priceColumn})::text AS price, e.settlement_assets AS assets
       FROM agents a ${readyEnrollment}
       WHERE a.id = $1 AND a.active AND e.enabled AND e.verified_at IS NOT NULL`,
      [input.agentId],
    );
    const target = found.rows[0];
    if (!target)
      throw new ApiError(
        404,
        "call_agent_unavailable",
        "That agent is not an available Super Agent.",
      );
    if (!target.price || !target.assets.includes(input.asset))
      throw new ApiError(
        422,
        "instant_calls_not_offered",
        `This agent does not take instant calls paid in ${assetLabel(input.asset)}.`,
      );
    if (target.owner_id === input.clientId)
      throw new ApiError(422, "self_hire_not_allowed", "An owner cannot hire their own agent.");
    const id = randomUUID();
    await client.query(
      `INSERT INTO superagent_calls
         (id, client_id, agent_id, service_slug, settlement_asset, price, idempotency_key, input_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.clientId,
        input.agentId,
        target.service_slug,
        input.asset,
        target.price,
        input.idempotencyKey ?? null,
        encryptPayload(input.request, payloadContext(id, "call-input")),
      ],
    );
    const accounts = await callAccounts(client, input.clientId, input.asset);
    await transfer(client, {
      reference: `call-hold:${id}`,
      type: "call_hold",
      from: accounts.available,
      to: accounts.held,
      amount: target.price,
      createdBy: input.clientId,
      metadata: { callId: id, agentId: input.agentId },
      asset: input.asset,
      insufficientFunds: new ApiError(
        402,
        "insufficient_credits",
        `Your available ${assetLabel(input.asset)} balance cannot cover this call (${target.price} ${assetLabel(input.asset)}). Top up and try again.`,
      ),
    });
    return { id, replay: false as const, target };
  });
}

/** Pays the agent's owner or refunds the client, once. A call already finished is left as it is. */
export async function finishCall(
  id: string,
  outcome: { status: "succeeded"; output: string } | { status: "refunded"; error: string },
  durationMs: number | null,
) {
  await inTransaction(async (client) => {
    const locked = await client.query<CallRow>(
      `SELECT ${callColumns} FROM superagent_calls c JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [id],
    );
    const call = locked.rows[0];
    if (!call || call.status !== "pending") return;
    const held = await callAccounts(client, call.client_id, call.settlement_asset);
    const payee =
      outcome.status === "succeeded"
        ? (await callAccounts(client, call.owner_id, call.settlement_asset)).available
        : held.available;
    await transfer(client, {
      reference: `call-${outcome.status === "succeeded" ? "payout" : "refund"}:${id}`,
      type: outcome.status === "succeeded" ? "call_payout" : "call_refund",
      from: held.held,
      to: payee,
      amount: call.price,
      metadata: { callId: id, agentId: call.agent_id },
      asset: call.settlement_asset,
    });
    await client.query(
      `UPDATE superagent_calls SET status = $2, output_ciphertext = $3, error = $4,
         duration_ms = $5, completed_at = now() WHERE id = $1`,
      [
        id,
        outcome.status,
        outcome.status === "succeeded"
          ? encryptPayload(outcome.output, payloadContext(id, "call-output"))
          : null,
        outcome.status === "refunded" ? outcome.error : null,
        durationMs,
      ],
    );
  });
}

/** Sends the call and decides the outcome from the runtime's reply. Never throws. */
async function dispatch(id: string, agentId: string, request: string, target: Target) {
  const secret = decryptPayload(
    target.secret_ciphertext,
    payloadContext(target.webhook_id, "webhook-secret"),
  );
  const body = JSON.stringify({
    id: randomUUID(),
    type: "superagent.call",
    callId: id,
    agentId,
    serviceSlug: target.service_slug,
    input: request,
  });
  try {
    const reply = await callTransport.send(
      target.url,
      body,
      {
        "content-type": "application/json",
        "x-liege-event-id": JSON.parse(body).id,
        "x-liege-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      env.INSTANT_CALL_TIMEOUT_MS,
    );
    let data: { status?: unknown; output?: unknown; reason?: unknown } = {};
    try {
      data = (JSON.parse(reply.body) as { data?: typeof data }).data ?? {};
    } catch {
      // Handled below as an unreadable reply.
    }
    if (reply.status === 200 && data.status === "declined")
      return {
        status: "refunded" as const,
        error:
          typeof data.reason === "string" && data.reason.trim()
            ? `The agent declined: ${data.reason.trim().slice(0, 500)}`
            : "The agent declined this call.",
      };
    const output = typeof data.output === "string" ? data.output : "";
    if (reply.status !== 200 || data.status !== "answered" || !output.trim())
      return {
        status: "refunded" as const,
        error: `The agent did not answer (HTTP ${reply.status}).`,
      };
    if (output.length > MAX_CALL_OUTPUT)
      return { status: "refunded" as const, error: "The agent's answer was too long." };
    const expected = callProof(secret, id, output);
    if (
      reply.proof.length !== expected.length ||
      !timingSafeEqual(Buffer.from(reply.proof), Buffer.from(expected))
    )
      return {
        status: "refunded" as const,
        error: "The agent's answer was not signed with its webhook secret.",
      };
    return { status: "succeeded" as const, output };
  } catch (error) {
    return {
      status: "refunded" as const,
      error: error instanceof Error ? error.message : "The agent could not be reached.",
    };
  }
}

export async function runCall(input: {
  clientId: string;
  agentId: string;
  request: string;
  asset: SettlementAsset;
  idempotencyKey?: string;
}) {
  const opened = await openCall(input);
  if (!opened.replay) {
    const started = Date.now();
    const outcome = await dispatch(opened.id, input.agentId, input.request, opened.target);
    await finishCall(opened.id, outcome, Date.now() - started);
  }
  return { row: (await loadCall(opened.id, input.clientId))!, replay: opened.replay };
}

/** Refunds calls left pending by a restart: well past the call timeout, nothing is still waiting. */
export async function refundStaleCalls(limit = 50) {
  const stale = await db.query<{ id: string }>(
    `SELECT id FROM superagent_calls WHERE status = 'pending'
       AND created_at < now() - ($1::int * interval '1 millisecond') ORDER BY created_at LIMIT $2`,
    [env.INSTANT_CALL_TIMEOUT_MS + 60_000, limit],
  );
  for (const row of stale.rows)
    await finishCall(
      row.id,
      { status: "refunded", error: "The call did not finish, so it was refunded." },
      null,
    );
  return stale.rowCount ?? 0;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startCallSweeper() {
  if (timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    void refundStaleCalls().catch((error) =>
      console.error(
        JSON.stringify({
          event: "calls.refund_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 60_000);
  timer.unref();
}
export function stopCallSweeper() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
