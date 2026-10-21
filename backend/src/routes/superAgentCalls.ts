import type { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { assetLabel } from "../assets.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import {
  callColumns,
  callPriceCap,
  loadCall,
  MAX_CALL_INPUT,
  presentCall,
  runCall,
  type CallRow,
} from "../superAgentCalls.js";

const callInput = z.object({
  agentId: z.string().uuid(),
  input: z.string().trim().min(1).max(MAX_CALL_INPUT),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  // Retrying with the same key returns the first call instead of charging again.
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
});

const price = z.number().finite().positive().nullable().optional();

export function registerCallRoutes(router: Router) {
  router.put(
    "/enrollments/:agentId/call-prices",
    requireAuth,
    asyncRoute(async (request, response) => {
      const agentId = z.string().uuid().parse(request.params.agentId);
      const input = z.object({ usdg: price, liege: price }).parse(request.body);
      const current = await db.query<{
        settlement_assets: string[];
        call_price_usdg: string | null;
        call_price_liege: string | null;
      }>(
        `SELECT e.settlement_assets, trim_scale(e.call_price_usdg)::text AS call_price_usdg,
           trim_scale(e.call_price_liege)::text AS call_price_liege
         FROM superagent_enrollments e JOIN agents a ON a.id = e.agent_id
         WHERE e.agent_id = $1 AND a.owner_id = $2`,
        [agentId, request.auth!.userId],
      );
      if (!current.rowCount)
        throw new ApiError(
          404,
          "enrollment_not_found",
          "Enroll this agent as a Super Agent first.",
        );
      // A field left out keeps its price; null turns instant calls off in that asset.
      const next = {
        usdg: input.usdg === undefined ? current.rows[0].call_price_usdg : input.usdg,
        liege: input.liege === undefined ? current.rows[0].call_price_liege : input.liege,
      };
      for (const asset of ["usdg", "liege"] as const) {
        const value = next[asset];
        if (value === null) continue;
        if (!current.rows[0].settlement_assets.includes(asset))
          throw new ApiError(
            422,
            "settlement_asset_not_supported",
            `This Super Agent is not enrolled to be paid in ${assetLabel(asset)}.`,
          );
        if (Number(value) > callPriceCap(asset))
          throw new ApiError(
            422,
            "call_price_too_high",
            `Instant calls cost at most ${callPriceCap(asset)} ${assetLabel(asset)}. Larger work belongs in a job with escrow and review.`,
          );
      }
      const result = await db.query(
        `UPDATE superagent_enrollments SET call_price_usdg = $2, call_price_liege = $3, updated_at = now()
         WHERE agent_id = $1 RETURNING agent_id, call_price_usdg, call_price_liege`,
        [agentId, next.usdg, next.liege],
      );
      await audit(db, {
        actorId: request.auth!.userId,
        action: "superagent.call_prices_set",
        targetType: "agent",
        targetId: agentId,
        requestId: request.requestId,
        metadata: { usdg: next.usdg, liege: next.liege },
      });
      response.json({ data: result.rows[0] });
    }),
  );

  router.post(
    "/calls",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const input = callInput.parse(request.body);
      const { row, replay } = await runCall({
        clientId: request.auth!.userId,
        agentId: input.agentId,
        request: input.input,
        asset: input.settlementAsset,
        idempotencyKey: input.idempotencyKey,
      });
      const call = presentCall(row, request.auth!.userId);
      if (row.status === "refunded")
        return response.status(502).json({
          error: {
            code: "call_failed",
            message: `${row.error ?? "The call failed."} You were not charged.`,
          },
          data: call,
        });
      response.status(replay ? 200 : 201).json({ data: call });
    }),
  );

  router.get(
    "/calls",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
        .parse(request.query);
      const result = await db.query<CallRow>(
        `SELECT ${callColumns}
         FROM superagent_calls c JOIN agents a ON a.id = c.agent_id
         WHERE c.client_id = $1 OR a.owner_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
        [request.auth!.userId, query.limit],
      );
      // The list stays light; open a call for its input and answer.
      response.json({
        data: result.rows.map((row) => ({
          ...presentCall(row, request.auth!.userId),
          input: undefined,
          output: undefined,
        })),
      });
    }),
  );

  router.get(
    "/calls/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const row = await loadCall(id, request.auth!.userId);
      if (!row) throw new ApiError(404, "call_not_found", "Call not found.");
      response.json({ data: presentCall(row, request.auth!.userId) });
    }),
  );
}
