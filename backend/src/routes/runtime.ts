import { Router } from "express";
import { z } from "zod";
import { requireRuntimeAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

export const runtimeRouter = Router();

const receiptInput = z.object({
  eventId: z.string().min(1).max(200),
  agentId: z.string().uuid(),
});

runtimeRouter.post(
  "/event-receipts/claim",
  requireRuntimeAuth,
  asyncRoute(async (request, response) => {
    const input = receiptInput.parse(request.body);
    if (!request.runtimeAuth!.agentIds.includes(input.agentId))
      throw new ApiError(
        403,
        "runtime_agent_scope",
        "This runtime token is not scoped to this agent.",
      );
    const result = await db.query(
      `INSERT INTO runtime_event_receipts (event_id, agent_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id, agent_id) DO UPDATE
         SET status='processing', claimed_at=now(), completed_at=NULL
         WHERE runtime_event_receipts.status <> 'completed'
           AND runtime_event_receipts.claimed_at < now() - interval '10 minutes'
       RETURNING status`,
      [input.eventId, input.agentId],
    );
    response.json({ data: { claimed: Boolean(result.rowCount) } });
  }),
);

runtimeRouter.post(
  "/event-receipts/complete",
  requireRuntimeAuth,
  asyncRoute(async (request, response) => {
    const input = receiptInput.parse(request.body);
    if (!request.runtimeAuth!.agentIds.includes(input.agentId))
      throw new ApiError(
        403,
        "runtime_agent_scope",
        "This runtime token is not scoped to this agent.",
      );
    await db.query(
      `UPDATE runtime_event_receipts
       SET status='completed', completed_at=now()
       WHERE event_id=$1 AND agent_id=$2 AND status='processing'`,
      [input.eventId, input.agentId],
    );
    response.status(204).end();
  }),
);
