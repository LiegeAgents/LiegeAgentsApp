import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import {
  EXPLORER,
  TRANSFER_EVENT,
  inspectContract,
  parseEventSignature,
  safeHead,
} from "../chainTriggers.js";
import { readySuperAgent } from "../superAgentSchedules.js";

const MAX_ACTIVE_TRIGGERS = 20;
export const DEFAULT_CHAIN_INSTRUCTIONS =
  "Explain what this onchain event means for holders: who moved what, how it compares with recent activity, and what to watch next.";

const address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Use a 0x address.")
  .transform((value) => value.toLowerCase());

const triggerInput = z
  .object({
    agentId: z.string().uuid(),
    kind: z.enum(["token_transfer", "contract_event"]).default("token_transfer"),
    contract: address,
    // Transfers: only moves of at least this many tokens, and only to or from this address.
    minAmount: z.number().finite().positive().optional(),
    watchAddress: address.optional(),
    // Contract events: the event to watch, e.g. OwnershipTransferred(address indexed, address indexed).
    eventSignature: z.string().trim().min(3).max(300).optional(),
    instructions: z.string().trim().min(1).max(2000).default(DEFAULT_CHAIN_INSTRUCTIONS),
    settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
    budgetAmount: z.number().finite().positive(),
    spendCap: z.number().finite().positive(),
    cooldownMinutes: z.number().int().min(5).max(10080).default(60),
    maxRunsPerDay: z.number().int().min(1).max(48).default(4),
    autoFund: z.boolean().default(false),
    source: z.enum(["dashboard", "cli"]).default("dashboard"),
  })
  .refine((input) => input.spendCap >= input.budgetAmount, {
    message: "The spending cap must cover at least one job.",
    path: ["spendCap"],
  })
  .refine((input) => input.kind === "token_transfer" || input.eventSignature, {
    message: "Name the event to watch.",
    path: ["eventSignature"],
  })
  .refine((input) => input.kind === "token_transfer" || (!input.minAmount && !input.watchAddress), {
    message: "Amount and address filters apply to token transfers.",
    path: ["kind"],
  });

const triggerColumns = `t.id, t.agent_id, a.name AS agent_name, t.kind, t.contract_address, t.event_signature,
  t.token_symbol, t.token_decimals, t.min_amount, t.watch_address, t.instructions, t.settlement_asset,
  t.budget_amount, t.spend_cap, t.committed_amount, t.runs_count, t.skipped_count, t.cooldown_minutes,
  t.max_runs_per_day, t.auto_fund, t.last_block, t.last_polled_at, t.last_fired_at, t.status,
  t.status_reason, t.source, t.created_at, t.updated_at,
  COALESCE((SELECT json_agg(r ORDER BY r.created_at DESC) FROM (
    SELECT r.id, r.block_number, r.tx_hash, r.summary, r.outcome, r.detail, r.created_at, r.job_id,
      j.status AS job_status, j.deadline_at AS job_deadline_at
    FROM superagent_chain_trigger_runs r LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.trigger_id = t.id ORDER BY r.created_at DESC LIMIT 10) r), '[]'::json) AS runs`;

async function ownedTrigger(id: string, userId: string) {
  const result = await db.query(
    `SELECT ${triggerColumns} FROM superagent_chain_triggers t JOIN agents a ON a.id = t.agent_id
     WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "chain_trigger_not_found", "This onchain trigger is not available.");
  return {
    ...result.rows[0],
    explorerUrl: `${EXPLORER}/address/${result.rows[0].contract_address}`,
  };
}

export function registerChainTriggerRoutes(router: Router) {
  // A trigger authorizes future spending, like a recurring job: operator sessions only.
  router.post(
    "/chain-triggers",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot create triggers.");
      const input = triggerInput.parse(request.body);
      const userId = request.auth!.userId;
      const transfer = input.kind === "token_transfer";
      const { signature, topic0 } = parseEventSignature(
        transfer ? TRANSFER_EVENT : input.eventSignature!,
      );
      // Read the chain before taking any locks: the contract must exist and, for transfers, be a token.
      const token = await inspectContract(input.contract, transfer);
      const head = await safeHead();
      const id = randomUUID();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `chain-triggers:${userId}`,
        ]);
        const active = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM superagent_chain_triggers WHERE user_id=$1 AND status IN ('active','paused')",
          [userId],
        );
        if (active.rows[0].count >= MAX_ACTIVE_TRIGGERS)
          throw new ApiError(
            409,
            "trigger_limit",
            `You can keep up to ${MAX_ACTIVE_TRIGGERS} onchain triggers. Cancel one first.`,
          );
        await readySuperAgent(
          client,
          input.agentId,
          input.settlementAsset,
          userId,
          input.budgetAmount,
        );
        await client.query(
          `INSERT INTO superagent_chain_triggers (id, user_id, agent_id, kind, contract_address,
             event_signature, topic0, token_symbol, token_decimals, min_amount, watch_address,
             instructions, settlement_asset, budget_amount, spend_cap, cooldown_minutes,
             max_runs_per_day, auto_fund, last_block, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            id,
            userId,
            input.agentId,
            input.kind,
            input.contract,
            signature,
            topic0,
            token.symbol,
            token.decimals,
            input.minAmount === undefined ? null : String(input.minAmount),
            input.watchAddress ?? null,
            input.instructions,
            input.settlementAsset,
            String(input.budgetAmount),
            String(input.spendCap),
            input.cooldownMinutes,
            input.maxRunsPerDay,
            input.autoFund,
            // Only events after the trigger is created count.
            head.toString(),
            input.source,
          ],
        );
        await audit(client, {
          actorId: userId,
          action: "superagent.chain_trigger_created",
          targetType: "superagent_chain_trigger",
          targetId: id,
          requestId: request.requestId,
          metadata: {
            agentId: input.agentId,
            kind: input.kind,
            contract: input.contract,
            budgetAmount: input.budgetAmount,
            spendCap: input.spendCap,
            autoFund: input.autoFund,
            source: input.source,
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.status(201).json({ data: await ownedTrigger(id, userId) });
    }),
  );

  router.get(
    "/chain-triggers",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const result = await db.query(
        `SELECT ${triggerColumns} FROM superagent_chain_triggers t JOIN agents a ON a.id = t.agent_id
         WHERE t.user_id = $1 ORDER BY (t.status IN ('active','paused')) DESC, t.created_at DESC LIMIT 100`,
        [request.auth!.userId],
      );
      response.json({ data: result.rows });
    }),
  );

  router.get(
    "/chain-triggers/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await ownedTrigger(id, request.auth!.userId) });
    }),
  );

  const control = (action: "pause" | "resume" | "cancel", from: string[], to: string) =>
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      // Resuming skips what happened while paused: scanning restarts at the current block.
      const head = action === "resume" ? (await safeHead()).toString() : null;
      const updated = await db.query(
        `UPDATE superagent_chain_triggers SET status=$3, status_reason=$4, updated_at=now(),
           last_block = COALESCE($6::bigint, last_block)
         WHERE id=$1 AND user_id=$2 AND status = ANY($5::text[]) RETURNING id`,
        [
          id,
          userId,
          to,
          action === "resume" ? null : action === "pause" ? "Paused by you." : "Cancelled by you.",
          from,
          head,
        ],
      );
      if (!updated.rowCount) {
        await ownedTrigger(id, userId);
        throw new ApiError(409, "invalid_trigger_transition", `This trigger cannot ${action}.`);
      }
      await audit(db, {
        actorId: userId,
        action: `superagent.chain_trigger_${{ pause: "paused", resume: "resumed", cancel: "cancelled" }[action]}`,
        targetType: "superagent_chain_trigger",
        targetId: id,
        requestId: request.requestId,
      });
      response.json({ data: await ownedTrigger(id, userId) });
    });

  router.post(
    "/chain-triggers/:id/pause",
    requireSessionOrMobileAuth("mobile:approve"),
    control("pause", ["active"], "paused"),
  );
  // Resuming re-authorizes spending, so it needs an operator session.
  router.post("/chain-triggers/:id/resume", requireAuth, control("resume", ["paused"], "active"));
  router.delete(
    "/chain-triggers/:id",
    requireSessionOrMobileAuth("mobile:approve"),
    control("cancel", ["active", "paused"], "cancelled"),
  );
}
