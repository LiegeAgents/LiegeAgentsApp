import type { PoolClient } from "pg";
import {
  decodeEventLog,
  formatUnits,
  getAddress,
  parseAbiItem,
  parseUnits,
  toEventSelector,
  type AbiEvent,
} from "viem";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { insertAttachment, LINK_MEDIA_TYPE } from "./routes/jobAttachments.js";
import {
  fundTriggeredJob,
  notifyTriggerFired,
  openSuperAgentJob,
  type SettlementAsset,
} from "./superAgentSchedules.js";

export const TRANSFER_EVENT = "Transfer(address indexed from, address indexed to, uint256 value)";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
// Blocks behind the head before an event is acted on, and the most blocks read per request.
const CONFIRMATIONS = 3n;
const MAX_RANGE = 5_000n;
const MAX_TRIGGERS_PER_PASS = 100;

/** JSON-RPC to Robinhood Chain. An object so tests can replace `call`. */
export const chainRpc = {
  async call(method: string, params: unknown[]): Promise<any> {
    const response = await fetch(env.RHC_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (!response.ok || body.error || body.result === undefined)
      throw new Error(
        `Robinhood Chain RPC ${method} failed: ${body.error?.message ?? response.status}`,
      );
    return body.result;
  },
};

export const safeHead = async () =>
  BigInt(await chainRpc.call("eth_blockNumber", [])) - CONFIRMATIONS;
const hex = (value: bigint) => `0x${value.toString(16)}`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Parses an event signature such as `OwnershipTransferred(address indexed a, address indexed b)`. */
export function parseEventSignature(signature: string) {
  const text = signature.trim().replace(/^event\s+/i, "");
  let event: AbiEvent;
  try {
    event = parseAbiItem(`event ${text}`) as AbiEvent;
  } catch {
    throw new ApiError(
      422,
      "invalid_event_signature",
      "Use an event signature like Transfer(address indexed from, address indexed to, uint256 value).",
    );
  }
  return { event, signature: text, topic0: toEventSelector(event).toLowerCase() };
}

/** Checks the address holds a contract and, for transfers, reads the token's symbol and decimals. */
export async function inspectContract(address: string, token: boolean) {
  const code = await chainRpc.call("eth_getCode", [address, "latest"]).catch(() => null);
  if (typeof code !== "string" || code === "0x")
    throw new ApiError(
      422,
      "not_a_contract",
      "No contract was found at that address on Robinhood Chain.",
    );
  if (!token) return { symbol: null, decimals: null };
  const read = (data: string) =>
    chainRpc.call("eth_call", [{ to: address, data }, "latest"]).catch(() => null);
  const [decimals, symbol] = await Promise.all([read("0x313ce567"), read("0x95d89b41")]);
  if (typeof decimals !== "string" || decimals === "0x")
    throw new ApiError(
      422,
      "not_a_token",
      "That contract does not look like a token (no decimals()).",
    );
  let name: string | null = null;
  try {
    const bytes = Buffer.from(String(symbol).slice(2), "hex");
    // ABI-encoded string: offset, length, then the bytes.
    const length = Number(BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`));
    name =
      bytes
        .subarray(64, 64 + length)
        .toString("utf8")
        .replace(/[^\x20-\x7e]/g, "") || null;
  } catch {
    name = null;
  }
  return { symbol: name?.slice(0, 40) ?? null, decimals: Number(BigInt(decimals)) };
}

type ChainLog = {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type ChainTriggerRow = {
  id: string;
  user_id: string;
  agent_id: string;
  kind: "token_transfer" | "contract_event";
  contract_address: string;
  event_signature: string;
  topic0: string;
  token_symbol: string | null;
  token_decimals: number | null;
  min_amount: string | null;
  watch_address: string | null;
  instructions: string;
  settlement_asset: SettlementAsset;
  budget_amount: string;
  spend_cap: string;
  committed_amount: string;
  cooldown_minutes: number;
  max_runs_per_day: number;
  auto_fund: boolean;
  last_block: string;
  status: string;
};

// `summary` is for people (short addresses); `detail` is the full record for the agent.
type Match = { log: ChainLog; summary: string; detail: string };

/** The trigger's matching events in a block range, oldest first, each with a one-line summary. */
function matches(trigger: ChainTriggerRow, logs: ChainLog[]): Match[] {
  const { event } = parseEventSignature(trigger.event_signature);
  const found: Match[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== trigger.topic0) continue;
    let args: Record<string, unknown> | null = null;
    try {
      args = decodeEventLog({ abi: [event], data: log.data, topics: log.topics as [`0x${string}`] })
        .args as Record<string, unknown>;
    } catch {
      args = null;
    }
    if (trigger.kind === "token_transfer") {
      if (!args) continue;
      const from = String(args.from).toLowerCase();
      const to = String(args.to).toLowerCase();
      const value = args.value as bigint;
      if (trigger.watch_address && from !== trigger.watch_address && to !== trigger.watch_address)
        continue;
      if (trigger.min_amount && value < parseUnits(trigger.min_amount, trigger.token_decimals!))
        continue;
      const amount = Number(formatUnits(value, trigger.token_decimals!)).toLocaleString("en-US", {
        maximumFractionDigits: 4,
      });
      const unit = trigger.token_symbol ?? "tokens";
      found.push({
        log,
        summary: `${amount} ${unit} moved from ${short(from)} to ${short(to)}`,
        detail: `${amount} ${unit} (token ${trigger.contract_address}) moved from ${from} to ${to}`,
      });
    } else {
      const entries = args ? Object.entries(args) : [];
      const isAddress = (value: unknown): value is string =>
        typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
      const render = (shorten: boolean) =>
        entries.length
          ? entries
              .map(
                ([key, value]) =>
                  `${key}=${isAddress(value) && shorten ? short(value) : String(value)}`,
              )
              .join(", ")
          : "undecoded";
      found.push({
        log,
        summary: `${event.name}(${render(true)}) on ${short(trigger.contract_address)}`.slice(
          0,
          500,
        ),
        detail: `${event.name}(${render(false)}) on contract ${trigger.contract_address}`.slice(
          0,
          2000,
        ),
      });
    }
  }
  return found.sort(
    (a, b) =>
      Number(BigInt(a.log.blockNumber) - BigInt(b.log.blockNumber)) ||
      Number(BigInt(a.log.logIndex) - BigInt(b.log.logIndex)),
  );
}

/**
 * Acts on the first matching event in a scanned range, within the trigger's limits: the spending
 * cap, the cooldown, the daily maximum, and one job waiting for funding at a time. Later matches
 * in the same range are counted as skipped.
 */
async function fire(client: PoolClient, trigger: ChainTriggerRow, found: Match[]) {
  if (!found.length) return { fired: null, skipped: 0 };
  const budget = Number(trigger.budget_amount);
  if (Number(trigger.committed_amount) + budget > Number(trigger.spend_cap)) {
    await client.query(
      "UPDATE superagent_chain_triggers SET status='completed', status_reason='Spending cap reached.', updated_at=now() WHERE id=$1",
      [trigger.id],
    );
    return { fired: null, skipped: found.length };
  }
  const limits = await client.query<{ cooling: boolean; today: number; waiting: number }>(
    `SELECT t.last_fired_at > now() - make_interval(mins => t.cooldown_minutes) AS cooling,
       (SELECT count(*)::int FROM superagent_chain_trigger_runs r
         WHERE r.trigger_id = t.id AND r.job_id IS NOT NULL AND r.created_at > now() - interval '1 day') AS today,
       -- Only jobs that can still be funded hold the trigger back.
       (SELECT count(*)::int FROM superagent_chain_trigger_runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.trigger_id = t.id AND j.status = 'open' AND j.deadline_at > now()) AS waiting
     FROM superagent_chain_triggers t WHERE t.id = $1`,
    [trigger.id],
  );
  const { cooling, today, waiting } = limits.rows[0];
  if (cooling || today >= trigger.max_runs_per_day || waiting)
    return { fired: null, skipped: found.length };

  const [first] = found;
  const block = BigInt(first.log.blockNumber);
  const txHash = first.log.transactionHash.toLowerCase();
  const txUrl = `${EXPLORER}/tx/${txHash}`;
  let outcome: "funded" | "awaiting_funding" | "failed" = "failed";
  let detail: string | null = null;
  let jobId: string | null = null;
  await client.query("SAVEPOINT chain_trigger_open");
  try {
    const job = await openSuperAgentJob(client, {
      userId: trigger.user_id,
      agentId: trigger.agent_id,
      asset: trigger.settlement_asset,
      budget,
      request: `${trigger.instructions}\n\nOnchain event on Robinhood Chain: ${first.detail}.\nTransaction: ${txUrl} (block ${block}).`,
      policy: {
        chainTriggerId: trigger.id,
        chainEvent: {
          contract: trigger.contract_address,
          txHash,
          logIndex: Number(BigInt(first.log.logIndex)),
          block: block.toString(),
        },
      },
      title: `${trigger.token_symbol ?? short(trigger.contract_address)}: ${first.summary}`,
    });
    await client.query("RELEASE SAVEPOINT chain_trigger_open");
    jobId = job.id;
    const link = JSON.stringify({ url: txUrl });
    await insertAttachment(client, {
      jobId: job.id,
      createdBy: trigger.user_id,
      kind: "link",
      mediaType: LINK_MEDIA_TYPE,
      name: txUrl,
      content: link,
      size: Buffer.byteLength(link),
    });
    await client.query(
      `UPDATE superagent_chain_triggers SET committed_amount = committed_amount + $2,
         runs_count = runs_count + 1, last_fired_at = now(), updated_at = now() WHERE id = $1`,
      [trigger.id, String(budget)],
    );
    ({ outcome, detail } = await fundTriggeredJob(
      client,
      job,
      trigger.user_id,
      trigger.auto_fund,
      "job",
    ));
    await notifyTriggerFired(client, {
      userId: trigger.user_id,
      job,
      funded: outcome === "funded",
      title: `Onchain trigger fired: ${trigger.token_symbol ?? short(trigger.contract_address)}`,
      what: first.summary,
      payload: { chainTriggerId: trigger.id, txHash, block: block.toString() },
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await client.query("ROLLBACK TO SAVEPOINT chain_trigger_open");
    detail = error.message;
  }
  await client.query(
    `INSERT INTO superagent_chain_trigger_runs (trigger_id, block_number, tx_hash, log_index, summary, job_id, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (trigger_id, tx_hash, log_index) DO NOTHING`,
    [
      trigger.id,
      block.toString(),
      txHash,
      Number(BigInt(first.log.logIndex)),
      first.summary,
      jobId,
      outcome,
      detail,
    ],
  );
  const committed = Number(trigger.committed_amount) + (jobId ? budget : 0);
  if (committed + budget > Number(trigger.spend_cap))
    await client.query(
      "UPDATE superagent_chain_triggers SET status='completed', status_reason='Spending cap reached.', updated_at=now() WHERE id=$1",
      [trigger.id],
    );
  await audit(client, {
    actorId: trigger.user_id,
    action: "superagent.chain_trigger_run",
    targetType: "superagent_chain_trigger",
    targetId: trigger.id,
    metadata: { txHash, block: block.toString(), outcome, jobId },
  });
  return { fired: { outcome, jobId, detail, summary: first.summary }, skipped: found.length - 1 };
}

/** Scans the next block range of one trigger and acts on what it finds. */
async function scan(trigger: ChainTriggerRow, head: bigint) {
  const from = BigInt(trigger.last_block) + 1n;
  if (from > head) return null;
  let to = head < from + MAX_RANGE - 1n ? head : from + MAX_RANGE - 1n;
  let logs: ChainLog[];
  for (;;) {
    try {
      logs = (await chainRpc.call("eth_getLogs", [
        {
          address: getAddress(trigger.contract_address),
          topics: [trigger.topic0],
          fromBlock: hex(from),
          toBlock: hex(to),
        },
      ])) as ChainLog[];
      break;
    } catch (error) {
      // A busy contract can match more logs than the RPC returns at once: scan half the range.
      if (to === from || !/limit|too many|exceed|range/i.test(String(error))) throw error;
      to = from + (to - from) / 2n;
    }
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<ChainTriggerRow>(
      "SELECT * FROM superagent_chain_triggers WHERE id = $1 FOR UPDATE",
      [trigger.id],
    );
    const current = locked.rows[0];
    // Another instance already scanned this range, or the trigger stopped meanwhile.
    if (!current || current.status !== "active" || current.last_block !== trigger.last_block) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await fire(client, current, matches(current, logs));
    await client.query(
      `UPDATE superagent_chain_triggers SET last_block = $2, last_polled_at = now(),
         skipped_count = skipped_count + $3 WHERE id = $1`,
      [trigger.id, to.toString(), result.skipped],
    );
    await client.query("COMMIT");
    return { triggerId: trigger.id, from: from.toString(), to: to.toString(), ...result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One pass over active triggers. A failing trigger is reported and retried on the next pass. */
export async function processChainTriggers() {
  const due = await db.query<ChainTriggerRow>(
    `SELECT * FROM superagent_chain_triggers WHERE status = 'active'
     ORDER BY last_polled_at NULLS FIRST LIMIT ${MAX_TRIGGERS_PER_PASS}`,
  );
  if (!due.rowCount) return [];
  const head = await safeHead();
  const results = [];
  for (const trigger of due.rows) {
    try {
      const result = await scan(trigger, head);
      if (result) results.push(result);
    } catch (error) {
      results.push({
        triggerId: trigger.id,
        error: error instanceof Error ? error.message : "failed",
      });
    }
  }
  return results;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startChainTriggers() {
  if (!env.CHAIN_TRIGGERS_INTERVAL_MS || timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void processChainTriggers()
      .catch((error) =>
        console.error(JSON.stringify({ event: "chain_triggers.failed", message: String(error) })),
      )
      .finally(() => {
        running = false;
      });
  }, env.CHAIN_TRIGGERS_INTERVAL_MS);
  timer.unref();
}

export function stopChainTriggers() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
