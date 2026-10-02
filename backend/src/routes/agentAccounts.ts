import { createHash } from "node:crypto";
import { Router } from "express";
import { verifyMessage } from "viem";
import { z } from "zod";
import {
  agentActionDigest,
  canonical,
  isTimeZone,
  normalizeAgentAction,
  ownerRuleReasons,
} from "../agentActions.js";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

const controlInput = z.object({
  command: z.enum(["pause", "resume", "kill"]),
  reason: z.string().max(500).optional(),
});
const policyInput = z.object({
  maxActionAmount: z.coerce.number().positive().nullable().optional(),
  dailyBudget: z.coerce.number().positive().nullable().optional(),
  monthlyBudget: z.coerce.number().positive().nullable().optional(),
  allowedAssets: z.array(z.string().min(1).max(80)).max(50).default([]),
  allowedVenues: z.array(z.string().min(1).max(120)).max(50).default([]),
  approvedCounterparties: z.array(z.string().min(1).max(120)).max(100).default([]),
  allowedActions: z.array(z.string().min(1).max(120)).max(100).default([]),
  approvalMode: z.enum(["always", "within_policy"]).default("always"),
  simulationRequired: z.boolean().default(true),
  requireHumanAbove: z.coerce.number().positive().nullable().optional(),
  activeHours: z
    .object({
      start: z.number().int().min(0).max(23),
      end: z.number().int().min(0).max(23),
    })
    .refine(
      (hours) => hours.start !== hours.end,
      "Active hours must start and end at different times.",
    )
    .nullable()
    .optional(),
  activeDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  timezone: z.string().max(64).refine(isTimeZone, "Unknown time zone.").default("UTC"),
});
const actionInput = z.object({
  action: z.string().min(1).max(120),
  amount: z.coerce.number().nonnegative().optional(),
  asset: z.string().min(1).max(80).optional(),
  venue: z.string().min(1).max(120).optional(),
  counterparty: z.string().min(1).max(120).optional(),
  details: z.record(z.unknown()).default({}),
  simulationId: z.string().uuid().optional(),
  simulationDigest: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{8,256}$/)
    .optional(),
  simulate: z.boolean().default(false),
});
const mandateInput = z.object({
  nonce: z.string().min(8).max(160),
  payload: z.record(z.unknown()),
  expiresAt: z.coerce.date(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  parentMandateId: z.string().uuid().optional(),
});

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

async function ownedAgent(agentId: string, userId: string) {
  const result = await db.query<{ wallet_address: string }>(
    "SELECT u.wallet_address FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id=$1 AND a.owner_id=$2",
    [agentId, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
  return result.rows[0].wallet_address;
}

export async function ensureAccount(agentId: string, userId: string) {
  await ownedAgent(agentId, userId);
  await db.query(
    "INSERT INTO agent_accounts (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING",
    [agentId],
  );
  await db.query(
    `INSERT INTO agent_account_policies (agent_id, updated_by) VALUES ($1,$2)
     ON CONFLICT (agent_id) DO NOTHING`,
    [agentId, userId],
  );
}

export const publicAccount = (row: Record<string, unknown>) => ({
  accountId: row.agent_id,
  agentId: row.agent_id,
  status: row.status,
  killReason: row.kill_reason,
  pausedAt: row.paused_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  policy:
    row.policy_version == null
      ? null
      : {
          version: Number(row.policy_version),
          maxActionAmount: row.max_action_amount == null ? null : String(row.max_action_amount),
          dailyBudget: row.daily_budget == null ? null : String(row.daily_budget),
          monthlyBudget: row.monthly_budget == null ? null : String(row.monthly_budget),
          allowedAssets: row.allowed_assets ?? [],
          allowedVenues: row.allowed_venues ?? [],
          approvedCounterparties: row.approved_counterparties ?? [],
          allowedActions: row.allowed_actions ?? [],
          approvalMode: row.approval_mode,
          simulationRequired: row.simulation_required,
          requireHumanAbove:
            row.require_human_above == null ? null : String(row.require_human_above),
          activeHours:
            row.active_hours_start == null
              ? null
              : { start: row.active_hours_start, end: row.active_hours_end },
          activeDays: row.active_days ?? [],
          timezone: row.active_timezone ?? "UTC",
          updatedAt: row.policy_updated_at,
        },
});

export const agentAccountsRouter = Router();
agentAccountsRouter.use(requireAuth);

agentAccountsRouter.post(
  "/",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.body?.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      `SELECT a.*, p.version AS policy_version, p.max_action_amount, p.daily_budget, p.monthly_budget,
        p.allowed_assets, p.allowed_venues, p.approved_counterparties, p.allowed_actions,
        p.approval_mode, p.simulation_required, p.require_human_above, p.active_hours_start,
        p.active_hours_end, p.active_days, p.active_timezone, p.updated_at AS policy_updated_at
       FROM agent_accounts a LEFT JOIN agent_account_policies p ON p.agent_id=a.agent_id
       WHERE a.agent_id=$1`,
      [agentId],
    );
    response.status(201).json({ data: publicAccount(result.rows[0]) });
  }),
);

agentAccountsRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT a.*, p.version AS policy_version, p.max_action_amount, p.daily_budget, p.monthly_budget,
        p.allowed_assets, p.allowed_venues, p.approved_counterparties, p.allowed_actions,
        p.approval_mode, p.simulation_required, p.require_human_above, p.active_hours_start,
        p.active_hours_end, p.active_days, p.active_timezone, p.updated_at AS policy_updated_at
       FROM agent_accounts a JOIN agents ag ON ag.id=a.agent_id
       LEFT JOIN agent_account_policies p ON p.agent_id=a.agent_id
       WHERE ag.owner_id=$1 ORDER BY a.created_at DESC`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows.map(publicAccount) });
  }),
);

agentAccountsRouter.get(
  "/:agentId",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      `SELECT a.*, p.version AS policy_version, p.max_action_amount, p.daily_budget, p.monthly_budget,
        p.allowed_assets, p.allowed_venues, p.approved_counterparties, p.allowed_actions,
        p.approval_mode, p.simulation_required, p.require_human_above, p.active_hours_start,
        p.active_hours_end, p.active_days, p.active_timezone, p.updated_at AS policy_updated_at
       FROM agent_accounts a LEFT JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1`,
      [agentId],
    );
    response.json({ data: publicAccount(result.rows[0]) });
  }),
);

agentAccountsRouter.put(
  "/:agentId/policy",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const input = policyInput.parse(request.body);
    const result = await db.query(
      `INSERT INTO agent_account_policies
       (agent_id, version, max_action_amount, daily_budget, monthly_budget, allowed_assets, allowed_venues,
        approved_counterparties, allowed_actions, approval_mode, simulation_required, updated_by,
        require_human_above, active_hours_start, active_hours_end, active_days, active_timezone)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (agent_id) DO UPDATE SET version=agent_account_policies.version+1,
        max_action_amount=EXCLUDED.max_action_amount, daily_budget=EXCLUDED.daily_budget,
        monthly_budget=EXCLUDED.monthly_budget, allowed_assets=EXCLUDED.allowed_assets,
        allowed_venues=EXCLUDED.allowed_venues, approved_counterparties=EXCLUDED.approved_counterparties,
        allowed_actions=EXCLUDED.allowed_actions, approval_mode=EXCLUDED.approval_mode,
        simulation_required=EXCLUDED.simulation_required, updated_by=EXCLUDED.updated_by,
        require_human_above=EXCLUDED.require_human_above, active_hours_start=EXCLUDED.active_hours_start,
        active_hours_end=EXCLUDED.active_hours_end, active_days=EXCLUDED.active_days,
        active_timezone=EXCLUDED.active_timezone, updated_at=now()
       RETURNING *`,
      [
        agentId,
        input.maxActionAmount ?? null,
        input.dailyBudget ?? null,
        input.monthlyBudget ?? null,
        input.allowedAssets.map((value) => value.toLowerCase()),
        input.allowedVenues.map((value) => value.toLowerCase()),
        input.approvedCounterparties.map((value) => value.toLowerCase()),
        input.allowedActions,
        input.approvalMode,
        input.simulationRequired,
        request.auth!.userId,
        input.requireHumanAbove ?? null,
        input.activeHours?.start ?? null,
        input.activeHours?.end ?? null,
        [...new Set(input.activeDays)].sort(),
        input.timezone,
      ],
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "agent_account.policy_updated",
      targetType: "agent_account",
      targetId: agentId,
      requestId: request.requestId,
      metadata: { version: result.rows[0].version },
    });
    response.json({
      data: publicAccount({
        agent_id: agentId,
        status: "active",
        policy_version: result.rows[0].version,
        ...result.rows[0],
      }),
    });
  }),
);

agentAccountsRouter.post(
  "/:agentId/control",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const input = controlInput.parse(request.body);
    if (input.command === "resume") {
      const current = await db.query<{ status: string }>(
        "SELECT status FROM agent_accounts WHERE agent_id=$1",
        [agentId],
      );
      if (current.rows[0]?.status === "killed")
        throw new ApiError(409, "account_killed", "A killed account cannot be resumed.");
    }
    const status =
      input.command === "kill" ? "killed" : input.command === "pause" ? "paused" : "active";
    const client = await db.connect();
    let result;
    let revokedConnections = 0;
    let rejectedProposals = 0;
    try {
      await client.query("BEGIN");
      result = await client.query(
        "UPDATE agent_accounts SET status=$2, kill_reason=$3, paused_at=CASE WHEN $2='active' THEN NULL ELSE COALESCE(paused_at, now()) END, updated_at=now() WHERE agent_id=$1 RETURNING *",
        [agentId, status, input.reason ?? null],
      );
      // A kill is permanent, so the agent's live runtime access and queued proposals end with it.
      if (status === "killed") {
        const revoked = await client.query(
          "UPDATE mcp_connections SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
          [agentId],
        );
        const rejected = await client.query(
          "UPDATE mcp_proposals SET status='rejected', decided_at=now() WHERE agent_id=$1 AND status='pending'",
          [agentId],
        );
        revokedConnections = revoked.rowCount ?? 0;
        rejectedProposals = rejected.rowCount ?? 0;
      }
      await audit(client, {
        actorId: request.auth!.userId,
        action: `agent_account.${input.command}`,
        targetType: "agent_account",
        targetId: agentId,
        requestId: request.requestId,
        metadata: { reason: input.reason ?? null, revokedConnections, rejectedProposals },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.json({
      data: {
        accountId: agentId,
        status: result.rows[0].status,
        killReason: result.rows[0].kill_reason,
        revokedConnections,
        rejectedProposals,
      },
    });
  }),
);

agentAccountsRouter.post(
  "/:agentId/actions/:actionId/approve",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const actionId = z.string().uuid().parse(request.params.actionId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      `UPDATE agent_account_actions SET decision='approved', approved_by=$3, approved_at=now(), receipt_digest=COALESCE(receipt_digest, simulation_digest)
       WHERE id=$1 AND agent_id=$2 AND simulation_id IS NOT NULL AND decision='approval_required' AND execution_status='not_started'
       RETURNING id,agent_id,decision,policy_version,simulation_id,simulation_digest,receipt_digest,approved_at`,
      [actionId, agentId, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(409, "action_unavailable", "This action is no longer awaiting approval.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "agent_account.action_approved",
      targetType: "agent_account_action",
      targetId: actionId,
      requestId: request.requestId,
      metadata: { agentId },
    });
    response.json({ data: result.rows[0] });
  }),
);

agentAccountsRouter.post(
  "/:agentId/actions/simulate",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const input = actionInput
      .omit({ simulationId: true, simulationDigest: true, simulate: true })
      .parse(request.body);
    const state = await db.query(
      "SELECT a.status, p.* FROM agent_accounts a JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1",
      [agentId],
    );
    const row = state.rows[0];
    const action = normalizeAgentAction(input);
    const violations: string[] = [];
    if (row.status !== "active") violations.push(`account_${row.status}`);
    if (row.allowed_actions.length && !row.allowed_actions.includes(action.action))
      violations.push("action_not_allowed");
    if (action.asset && row.allowed_assets.length && !row.allowed_assets.includes(action.asset))
      violations.push("asset_not_allowed");
    if (action.venue && row.allowed_venues.length && !row.allowed_venues.includes(action.venue))
      violations.push("venue_not_allowed");
    if (
      action.counterparty &&
      row.approved_counterparties.length &&
      !row.approved_counterparties.includes(action.counterparty)
    )
      violations.push("counterparty_not_allowed");
    const limits = await db.query<{
      action_exceeded: boolean;
      daily_exceeded: boolean;
      monthly_exceeded: boolean;
    }>(
      `SELECT
         ($2::numeric IS NOT NULL AND p.max_action_amount IS NOT NULL AND $2::numeric > p.max_action_amount) AS action_exceeded,
         ($2::numeric IS NOT NULL AND p.daily_budget IS NOT NULL AND
           COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
             AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('day', now())), 0) + $2::numeric > p.daily_budget) AS daily_exceeded,
         ($2::numeric IS NOT NULL AND p.monthly_budget IS NOT NULL AND
           COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
             AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('month', now())), 0) + $2::numeric > p.monthly_budget) AS monthly_exceeded
       FROM agent_account_policies p WHERE p.agent_id=$1`,
      [agentId, action.amount],
    );
    if (limits.rows[0]?.action_exceeded) violations.push("action_limit_exceeded");
    if (limits.rows[0]?.daily_exceeded) violations.push("daily_budget_exceeded");
    if (limits.rows[0]?.monthly_exceeded) violations.push("monthly_budget_exceeded");
    const ownerRules = ownerRuleReasons(row, action.amount);
    violations.push(...ownerRules.denied);
    const actionDigest = agentActionDigest(agentId, Number(row.version), action);
    const result = {
      eligible: violations.length === 0,
      violations,
      approvalRequired: row.approval_mode === "always" || ownerRules.review.length > 0,
      reviewReasons: ownerRules.review,
      policyVersion: Number(row.version),
    };
    const inserted = await db.query(
      `INSERT INTO agent_account_simulations (agent_id,policy_version,action_digest,action,result,created_by,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,now() + interval '15 minutes')
       ON CONFLICT (action_digest) DO UPDATE SET result=EXCLUDED.result, expires_at=EXCLUDED.expires_at, created_at=now()
       RETURNING id,action_digest,action,result,policy_version,expires_at,created_at`,
      [
        agentId,
        row.version,
        actionDigest,
        JSON.stringify(action),
        JSON.stringify(result),
        request.auth!.userId,
      ],
    );
    response.status(201).json({ data: inserted.rows[0] });
  }),
);

agentAccountsRouter.post(
  "/:agentId/actions/authorize",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const input = actionInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query(
        "SELECT a.*, p.* FROM agent_accounts a JOIN agent_account_policies p ON p.agent_id=a.agent_id WHERE a.agent_id=$1 FOR UPDATE",
        [agentId],
      );
      const row = state.rows[0];
      const normalizedAction = normalizeAgentAction(input);
      let boundSimulationId: string | null = null;
      let boundDigest: string | null = null;
      if (!input.simulate && (row.simulation_required || input.simulationId)) {
        if (!input.simulationId)
          throw new ApiError(
            400,
            "simulation_required",
            "Run a simulation and provide its simulationId before authorization.",
          );
        const simulation = await client.query<{
          id: string;
          action_digest: string;
          action: Record<string, unknown>;
          policy_version: number;
          expires_at: Date;
        }>(
          "SELECT id,action_digest,action,policy_version,expires_at FROM agent_account_simulations WHERE id=$1 AND agent_id=$2 FOR UPDATE",
          [input.simulationId, agentId],
        );
        if (!simulation.rowCount || simulation.rows[0].expires_at <= new Date())
          throw new ApiError(409, "simulation_expired", "The simulation is missing or expired.");
        const expectedDigest = agentActionDigest(agentId, Number(row.version), normalizedAction);
        if (
          simulation.rows[0].policy_version !== Number(row.version) ||
          simulation.rows[0].action_digest !== expectedDigest
        )
          throw new ApiError(
            409,
            "simulation_mismatch",
            "The action no longer matches its simulation and policy version.",
          );
        boundSimulationId = simulation.rows[0].id;
        boundDigest = simulation.rows[0].action_digest;
      }
      const reasons: string[] = [];
      if (row.status !== "active") reasons.push(`account_${row.status}`);
      if (row.allowed_actions.length && !row.allowed_actions.includes(input.action))
        reasons.push("action_not_allowed");
      if (
        input.asset &&
        row.allowed_assets.length &&
        !row.allowed_assets.includes(input.asset.toLowerCase())
      )
        reasons.push("asset_not_allowed");
      if (
        input.venue &&
        row.allowed_venues.length &&
        !row.allowed_venues.includes(input.venue.toLowerCase())
      )
        reasons.push("venue_not_allowed");
      if (
        input.counterparty &&
        row.approved_counterparties.length &&
        !row.approved_counterparties.includes(input.counterparty.toLowerCase())
      )
        reasons.push("counterparty_not_allowed");
      const limits = await client.query<{
        action_exceeded: boolean;
        daily_exceeded: boolean;
        monthly_exceeded: boolean;
      }>(
        `SELECT
           ($2::numeric IS NOT NULL AND p.max_action_amount IS NOT NULL AND $2::numeric > p.max_action_amount) AS action_exceeded,
           ($2::numeric IS NOT NULL AND p.daily_budget IS NOT NULL AND
             COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
               AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('day', now())), 0) + $2::numeric > p.daily_budget) AS daily_exceeded,
           ($2::numeric IS NOT NULL AND p.monthly_budget IS NOT NULL AND
             COALESCE((SELECT SUM(amount) FROM agent_account_actions WHERE agent_id=$1
               AND decision IN ('approved', 'approval_required') AND created_at >= date_trunc('month', now())), 0) + $2::numeric > p.monthly_budget) AS monthly_exceeded
         FROM agent_account_policies p WHERE p.agent_id=$1`,
        [agentId, input.amount ?? null],
      );
      if (limits.rows[0]?.action_exceeded) reasons.push("action_limit_exceeded");
      if (limits.rows[0]?.daily_exceeded) reasons.push("daily_budget_exceeded");
      if (limits.rows[0]?.monthly_exceeded) reasons.push("monthly_budget_exceeded");
      const ownerRules = ownerRuleReasons(row, input.amount ?? null);
      reasons.push(...ownerRules.denied, ...ownerRules.review);
      if (row.simulation_required && !boundDigest && !input.simulationDigest && !input.simulate)
        reasons.push("simulation_required");
      // These route the action to the owner for approval instead of denying it.
      const reviewReasons = new Set(["simulation_required", "human_approval_required"]);
      const hardReasons = reasons.filter((reason) => !reviewReasons.has(reason));
      const decision = input.simulate
        ? "simulation"
        : hardReasons.length
          ? "denied"
          : reasons.length || row.approval_mode === "always"
            ? "approval_required"
            : "approved";
      const recorded = await client.query(
        "INSERT INTO agent_account_actions (agent_id,action,amount,asset,venue,counterparty,decision,reasons,policy_version,simulation_digest,simulation_id,normalized_action,receipt_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (simulation_id) DO NOTHING RETURNING id,created_at",
        [
          agentId,
          input.action,
          input.amount ?? null,
          input.asset?.toLowerCase() ?? null,
          input.venue?.toLowerCase() ?? null,
          input.counterparty?.toLowerCase() ?? null,
          decision,
          reasons,
          row.version,
          boundDigest ?? input.simulationDigest ?? null,
          boundSimulationId,
          JSON.stringify(normalizedAction),
          boundDigest,
        ],
      );
      if (!recorded.rowCount)
        throw new ApiError(
          409,
          "simulation_already_authorized",
          "This simulation has already been authorized.",
        );
      await client.query("COMMIT");
      response.json({
        data: {
          actionId: recorded.rows[0].id,
          accountId: agentId,
          decision,
          reasons,
          policyVersion: row.version,
          simulationDigest: boundDigest ?? input.simulationDigest ?? null,
          createdAt: recorded.rows[0].created_at,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

agentAccountsRouter.post(
  "/:agentId/mandates",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const wallet = await ownedAgent(agentId, request.auth!.userId);
    await ensureAccount(agentId, request.auth!.userId);
    const input = mandateInput.parse(request.body);
    if (input.expiresAt <= new Date())
      throw new ApiError(400, "mandate_expired", "A mandate must expire in the future.");
    const contents = {
      agentId,
      nonce: input.nonce,
      expiresAt: input.expiresAt.toISOString(),
      payload: input.payload,
      parentMandateId: input.parentMandateId ?? null,
    };
    const mandateDigest = digest(contents);
    if (input.parentMandateId) {
      const parent = await db.query(
        "SELECT id FROM agent_mandates WHERE id=$1 AND agent_id=$2 AND status='active' AND expires_at > now()",
        [input.parentMandateId, agentId],
      );
      if (!parent.rowCount)
        throw new ApiError(
          400,
          "invalid_parent_mandate",
          "The parent mandate is not active for this account.",
        );
    }
    let valid = false;
    try {
      valid = await verifyMessage({
        address: wallet as `0x${string}`,
        message: `Liege Agent Mandate\n${mandateDigest}`,
        signature: input.signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid)
      throw new ApiError(
        401,
        "invalid_mandate_signature",
        "The mandate signature does not match the agent owner wallet.",
      );
    const result = await db.query(
      "INSERT INTO agent_mandates (agent_id,issuer_id,parent_mandate_id,nonce,digest,payload,signature,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (agent_id, nonce) DO NOTHING RETURNING id,agent_id,nonce,digest,payload,status,expires_at,created_at",
      [
        agentId,
        request.auth!.userId,
        input.parentMandateId ?? null,
        input.nonce,
        mandateDigest,
        JSON.stringify(input.payload),
        input.signature,
        input.expiresAt,
      ],
    );
    if (!result.rowCount)
      throw new ApiError(409, "mandate_nonce_used", "This mandate nonce has already been used.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "agent_account.mandate_created",
      targetType: "agent_mandate",
      targetId: result.rows[0].id,
      requestId: request.requestId,
      metadata: { agentId, digest: mandateDigest },
    });
    response.status(201).json({ data: result.rows[0] });
  }),
);

agentAccountsRouter.get(
  "/:agentId/mandates",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      "SELECT id,agent_id,parent_mandate_id,nonce,digest,payload,signature,status,expires_at,revoked_at,created_at FROM agent_mandates WHERE agent_id=$1 ORDER BY created_at DESC",
      [agentId],
    );
    response.json({ data: result.rows });
  }),
);

agentAccountsRouter.post(
  "/:agentId/mandates/:mandateId/revoke",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const mandateId = z.string().uuid().parse(request.params.mandateId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      "UPDATE agent_mandates SET status='revoked', revoked_at=now() WHERE id=$1 AND agent_id=$2 AND status='active' RETURNING id,status,revoked_at",
      [mandateId, agentId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "mandate_not_found", "This mandate is unavailable.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "agent_account.mandate_revoked",
      targetType: "agent_mandate",
      targetId: mandateId,
      requestId: request.requestId,
      metadata: { agentId },
    });
    response.json({ data: result.rows[0] });
  }),
);

export function formatAp2Mandate(
  row: {
    id: string;
    agent_id: string;
    parent_mandate_id?: string | null;
    nonce: string;
    digest: string;
    payload: unknown;
    signature: string;
    status: string;
    expires_at: Date | string;
    created_at: Date | string;
  },
  wallet: string,
) {
  const payload =
    ((typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<
      string,
      unknown
    >) || {};
  const createdAtIso = new Date(row.created_at).toISOString();
  const expiresAtIso = new Date(row.expires_at).toISOString();
  const allowedActions = Array.isArray(payload.actions)
    ? payload.actions
    : Array.isArray(payload.allowedActions)
      ? payload.allowedActions
      : [];
  const maxAmount =
    payload.maxAmount != null
      ? String(payload.maxAmount)
      : payload.max_amount != null
        ? String(payload.max_amount)
        : null;
  const dailyBudget =
    payload.dailyBudget != null
      ? String(payload.dailyBudget)
      : payload.daily_budget != null
        ? String(payload.daily_budget)
        : null;
  const monthlyBudget =
    payload.monthlyBudget != null
      ? String(payload.monthlyBudget)
      : payload.monthly_budget != null
        ? String(payload.monthly_budget)
        : null;
  const currency = typeof payload.asset === "string" ? payload.asset.toUpperCase() : "USDG";
  const allowedAssets = Array.isArray(payload.allowedAssets)
    ? payload.allowedAssets.map((a: unknown) => String(a).toUpperCase())
    : ["USDG", "LIEGE"];
  const allowedPayees = Array.isArray(payload.approvedCounterparties)
    ? payload.approvedCounterparties
    : Array.isArray(payload.allowedPayees)
      ? payload.allowedPayees
      : [];
  const allowedVenues = Array.isArray(payload.allowedVenues) ? payload.allowedVenues : [];

  return {
    protocol: "ap2",
    version: "0.2",
    vct: "mandate.payment.open.1",
    mandate_id: row.id,
    agent_id: row.agent_id,
    status: row.status,
    issuer: {
      id: `did:pkh:eip155:4663:${wallet}`,
      address: wallet,
      chain_id: 4663,
      network: "robinhood_chain",
    },
    subject: {
      agent_id: row.agent_id,
      account_id: row.agent_id,
    },
    "ap2.mandates.PaymentMandate": {
      mandate_id: row.id,
      parent_mandate_id: row.parent_mandate_id ?? null,
      creation_time: createdAtIso,
      expiration_time: expiresAtIso,
      nonce: row.nonce,
      constraints: {
        type: "payment.open_constraints",
        allowed_actions: allowedActions,
        max_amount: maxAmount,
        daily_budget: dailyBudget,
        monthly_budget: monthlyBudget,
        currency,
        allowed_assets: allowedAssets,
        allowed_payees: allowedPayees,
        allowed_venues: allowedVenues,
      },
      payload,
    },
    "ap2.mandates.IntentMandate": {
      natural_language_description:
        typeof payload.description === "string"
          ? payload.description
          : typeof payload.naturalLanguageDescription === "string"
            ? payload.naturalLanguageDescription
            : `Mandate authorization for Liege Agent ${row.agent_id}`,
      user_cart_confirmation_required: Boolean(payload.userCartConfirmationRequired ?? false),
      requires_refundability: Boolean(payload.requiresRefundability ?? true),
      intent_expiry: expiresAtIso,
      merchants: allowedPayees,
      constraints: {
        max_amount: maxAmount,
        currency,
        allowed_assets: allowedAssets,
      },
    },
    proof: {
      type: "EthereumPersonalSignature2021",
      verification_method: `did:pkh:eip155:4663:${wallet}#recovery`,
      created: createdAtIso,
      proof_purpose: "assertionMethod",
      digest: row.digest,
      signature: row.signature,
    },
  };
}

agentAccountsRouter.get(
  ["/:agentId/mandates/:id/ap2", "/:agentId/mandates/:mandateId/ap2"],
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const mandateId = z
      .string()
      .uuid()
      .parse(request.params.id || request.params.mandateId);
    const wallet = await ownedAgent(agentId, request.auth!.userId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      "SELECT id,agent_id,parent_mandate_id,nonce,digest,payload,signature,status,expires_at,revoked_at,created_at FROM agent_mandates WHERE id=$1 AND agent_id=$2",
      [mandateId, agentId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "mandate_not_found", "This mandate is unavailable.");
    const row = result.rows[0];
    const ap2Doc = formatAp2Mandate(row, wallet);
    response.setHeader("Content-Type", "application/json");
    if (request.query.download === "1") {
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="liege-mandate-${row.id}.ap2.json"`,
      );
    }
    response.json({ data: ap2Doc });
  }),
);

agentAccountsRouter.get(
  ["/:agentId/mandates/:id", "/:agentId/mandates/:mandateId"],
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const mandateId = z
      .string()
      .uuid()
      .parse(request.params.id || request.params.mandateId);
    const wallet = await ownedAgent(agentId, request.auth!.userId);
    await ensureAccount(agentId, request.auth!.userId);
    const result = await db.query(
      "SELECT id,agent_id,parent_mandate_id,nonce,digest,payload,signature,status,expires_at,revoked_at,created_at FROM agent_mandates WHERE id=$1 AND agent_id=$2",
      [mandateId, agentId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "mandate_not_found", "This mandate is unavailable.");
    const row = result.rows[0];
    if (request.query.format === "ap2") {
      const ap2Doc = formatAp2Mandate(row, wallet);
      response.json({ data: ap2Doc });
      return;
    }
    response.json({ data: row });
  }),
);
