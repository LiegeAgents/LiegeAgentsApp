import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { createWebhookSubscription } from "../webhooks.js";

const eventTypes = z
  .array(
    z.enum([
      "job.funded",
      "job.submitted",
      "job.completed",
      "job.rejected",
      "job.expired",
      "job.settled",
    ]),
  )
  .min(1)
  .default([
    "job.funded",
    "job.submitted",
    "job.completed",
    "job.rejected",
    "job.expired",
    "job.settled",
  ]);
const input = z.object({
  agentId: z.string().uuid(),
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "Webhook URLs must use HTTPS."),
  eventTypes,
});
export const webhooksRouter = Router();

webhooksRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const value = input.parse(request.body);
    const owned = await db.query("SELECT id FROM agents WHERE id = $1 AND owner_id = $2", [
      value.agentId,
      request.auth!.userId,
    ]);
    if (!owned.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    const created = await createWebhookSubscription(
      request.auth!.userId,
      value.agentId,
      value.url,
      value.eventTypes,
    );
    response.status(201).json({ data: created });
  }),
);

webhooksRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "SELECT id, agent_id, url, event_types, active, created_at, updated_at FROM webhook_subscriptions WHERE owner_id = $1 ORDER BY created_at DESC",
      [request.auth!.userId],
    );
    response.json({ data: result.rows });
  }),
);

webhooksRouter.delete(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "UPDATE webhook_subscriptions SET active = false, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "webhook_not_found", "This webhook subscription is unavailable.");
    response.status(204).end();
  }),
);

webhooksRouter.get(
  "/stream/:agentId",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const owned = await db.query("SELECT id FROM agents WHERE id = $1 AND owner_id = $2", [
      agentId,
      request.auth!.userId,
    ]);
    if (!owned.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    const requestedSince =
      typeof request.query.since === "string" ? request.query.since : undefined;
    let cursor =
      requestedSince && !Number.isNaN(Date.parse(requestedSince))
        ? requestedSince
        : "1970-01-01T00:00:00.000Z";
    response
      .status(200)
      .set({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      .flushHeaders();
    let closed = false;
    const send = async () => {
      if (closed) return;
      const events = await db.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT e.id, e.event_type, e.payload, e.created_at FROM webhook_events e JOIN jobs j ON j.id = e.job_id
       WHERE j.agent_id = $1 AND e.created_at > $2 ORDER BY e.created_at LIMIT 100`,
        [agentId, cursor],
      );
      for (const event of events.rows)
        response.write(
          `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
        );
      if (events.rowCount) cursor = events.rows[events.rows.length - 1].created_at.toISOString();
      response.write(`: keep-alive ${Date.now()}\n\n`);
    };
    await send();
    const timer = setInterval(() => void send(), 5_000);
    const close = () => {
      closed = true;
      clearInterval(timer);
    };
    request.on("close", close);
    setTimeout(() => {
      if (!closed) response.end();
      close();
    }, 55_000);
  }),
);
