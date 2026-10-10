import { createHmac, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as ipaddr from "ipaddr.js";
import type { Pool, PoolClient } from "pg";
import { db } from "./db/index.js";
import { encryptPayload, decryptPayload, payloadContext } from "./crypto.js";

export const webhookSecret = () => `whsec_${randomBytes(32).toString("hex")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type WebhookEvent = {
  id: string;
  cursor: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export function parseWebhookCursor(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Webhook event cursor must be a non-negative integer.");
  return BigInt(value);
}

export function requestedWebhookCursor(after: unknown, lastEventId: string | undefined) {
  if (after !== undefined) return parseWebhookCursor(after);
  return lastEventId ? parseWebhookCursor(lastEventId) : 0n;
}

export function formatWebhookSseEvent(event: WebhookEvent) {
  return `id: ${event.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export async function replayWebhookEvents(
  client: Pool | PoolClient,
  agentId: string,
  after: bigint,
  limit = 100,
  filters: { jobId?: string; eventType?: string } = {},
) {
  const result = await client.query<{
    id: string;
    cursor: string;
    event_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT e.id, e.cursor, e.event_type, e.payload
     FROM webhook_events e LEFT JOIN jobs j ON j.id = e.job_id
     LEFT JOIN invoices i ON i.id = e.invoice_id
     WHERE COALESCE(j.agent_id, i.agent_id) = $1 AND e.cursor > $2::bigint
       AND ($4::uuid IS NULL OR e.job_id = $4::uuid)
       AND ($5::text IS NULL OR e.event_type = $5::text)
     ORDER BY e.cursor ASC LIMIT $3`,
    [agentId, after.toString(), limit, filters.jobId ?? null, filters.eventType ?? null],
  );
  return result.rows.map(
    (event) =>
      ({
        id: event.id,
        cursor: event.cursor,
        eventType: event.event_type,
        payload: event.payload,
      }) satisfies WebhookEvent,
  );
}

function privateAddress(address: string) {
  try {
    // `process` reduces IPv4-mapped IPv6 addresses before classifying them.
    return ipaddr.process(address).range() !== "unicast";
  } catch {
    return true;
  }
}

export async function assertSafeWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Webhook URLs must use HTTPS without embedded credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
    throw new Error("Webhook URLs may not target local hostnames.");
  const addresses = isIP(hostname)
    ? [hostname]
    : (await lookup(hostname, { all: true })).map((item) => item.address);
  if (!addresses.length || addresses.some(privateAddress))
    throw new Error("Webhook URLs may not target private or link-local addresses.");
  return url.toString();
}

export async function enqueueWebhookEvent(
  client: Pool | PoolClient,
  input: {
    jobId?: string;
    invoiceId?: string;
    eventType: string;
    actorId?: string;
    data?: Record<string, unknown>;
  },
) {
  if (Boolean(input.jobId) === Boolean(input.invoiceId))
    throw new Error("A webhook event needs exactly one job or invoice subject.");
  const eventId = crypto.randomUUID();
  const payload = {
    id: eventId,
    type: input.eventType,
    createdAt: new Date().toISOString(),
    ...(input.jobId ? { jobId: input.jobId } : { invoiceId: input.invoiceId }),
    data: { ...(input.data ?? {}), ...(input.actorId ? { actorId: input.actorId } : {}) },
  };
  const event = await client.query<{ id: string; cursor: string }>(
    "INSERT INTO webhook_events (id, job_id, invoice_id, event_type, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id, cursor",
    [
      eventId,
      input.jobId ?? null,
      input.invoiceId ?? null,
      input.eventType,
      JSON.stringify(payload),
    ],
  );
  await client.query(
    `INSERT INTO webhook_deliveries (event_id, subscription_id)
     SELECT $1, id FROM webhook_subscriptions
     WHERE agent_id = COALESCE((SELECT agent_id FROM jobs WHERE id = $2), (SELECT agent_id FROM invoices WHERE id = $3))
       AND active AND $4 = ANY(event_types)
     ON CONFLICT DO NOTHING`,
    [event.rows[0].id, input.jobId ?? null, input.invoiceId ?? null, input.eventType],
  );
}

export async function createWebhookSubscription(
  ownerId: string,
  agentId: string,
  url: string,
  eventTypes: string[],
) {
  const id = crypto.randomUUID();
  const secret = webhookSecret();
  const result = await db.query(
    `INSERT INTO webhook_subscriptions (id, owner_id, agent_id, url, secret_hash, secret_ciphertext, event_types)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, agent_id, url, event_types, active, created_at`,
    [
      id,
      ownerId,
      agentId,
      url,
      hash(secret),
      encryptPayload(secret, payloadContext(id, "webhook-secret")),
      eventTypes,
    ],
  );
  return { ...result.rows[0], secret };
}

export async function deliverPendingWebhooks(limit = 50) {
  const due = await db.query<{
    id: string;
    event_id: string;
    subscription_id: string;
    attempt: number;
    url: string;
    secret_ciphertext: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT d.id, d.event_id, d.subscription_id, d.attempt, s.url, s.secret_ciphertext, e.payload
     FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
     JOIN webhook_events e ON e.id = d.event_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.active
     ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
    [limit],
  );
  let delivered = 0;
  for (const item of due.rows) {
    const claimed = await db.query(
      "UPDATE webhook_deliveries SET next_attempt_at = now() + interval '5 minutes' WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now() RETURNING id",
      [item.id],
    );
    if (!claimed.rowCount) continue;
    const secret = decryptPayload(
      item.secret_ciphertext,
      payloadContext(item.subscription_id, "webhook-secret"),
    );
    const body = JSON.stringify(item.payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    try {
      await assertSafeWebhookUrl(item.url);
      const response = await fetch(item.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-liege-event-id": item.event_id,
          "x-liege-signature": `sha256=${signature}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      await db.query(
        "UPDATE webhook_deliveries SET status = 'delivered', response_status = $2, delivered_at = now() WHERE id = $1",
        [item.id, response.status],
      );
      delivered++;
    } catch (error) {
      const attempt = item.attempt + 1;
      await db.query(
        "UPDATE webhook_deliveries SET attempt = $2, last_error = $3, next_attempt_at = now() + ($4::int * interval '1 minute'), status = CASE WHEN $2 >= 12 THEN 'failed' ELSE 'pending' END WHERE id = $1",
        [
          item.id,
          attempt,
          error instanceof Error ? error.message : String(error),
          Math.min(60, 2 ** Math.min(attempt, 6)),
        ],
      );
    }
  }
  return { attempted: due.rowCount, delivered };
}
