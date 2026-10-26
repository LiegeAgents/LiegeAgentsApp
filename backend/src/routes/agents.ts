import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { canonical } from "../agentActions.js";
import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { requireAuth } from "../auth.js";
import { ApiError, asyncRoute } from "../http.js";
import { MIN_SCORED_JOBS, REPUTATION_WEIGHTS, agentStanding } from "../reputation.js";
import { badgeMessage, renderBadge } from "../agentBadge.js";
import { isEd25519PublicKey, keyFingerprint } from "../deliverableSignatures.js";
import { reputationProof } from "../jobReceipts.js";

const createAgent = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().min(2).max(80),
    description: z.string().min(20).max(2000),
    category: z.string().min(2).max(80),
    capabilities: z.array(z.string().min(1).max(80)).max(20).default([]),
    settlementAssets: z
      .array(z.enum(["usdg", "liege"]).or(z.string()))
      .min(1)
      // Legacy callers omitted settlementAssets; keep those agents compatible with both
      // independent rails while new clients can explicitly narrow the list.
      .default(["usdg", "liege"]),
    metadata: z.record(z.unknown()).default({}),
  })
  .transform((value, ctx) => {
    const assets = [...new Set(value.settlementAssets.map((asset) => asset.toLowerCase()))];
    if (assets.some((asset) => asset !== "usdg" && asset !== "liege")) {
      ctx.addIssue({
        code: "custom",
        path: ["settlementAssets"],
        message: "Settlement assets must be usdg or liege.",
      });
    }
    return { ...value, settlementAssets: assets };
  });

export const agentsRouter = Router();

agentsRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        category: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(24),
        cursor: z.string().uuid().optional(),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT a.id, a.slug, a.name, a.description, a.category, a.capabilities, a.settlement_assets, a.reputation_score, a.created_at, u.wallet_address AS owner_wallet,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', s.id, 'slug', s.slug, 'name', s.name,
                  'price_usd', s.price_usd, 'settlement_assets', s.settlement_assets
                ) ORDER BY s.created_at ASC)
                FROM commerce_services s
                WHERE s.agent_id = a.id AND s.active
              ), '[]'::json) AS services
     FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.active AND ($1::text IS NULL OR a.category = $1)
       AND ($2::uuid IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [query.category ?? null, query.cursor ?? null, query.limit + 1],
    );
    const agents = result.rows.slice(0, query.limit);
    const standing = await agentStanding(agents.map((agent) => agent.id));
    response.json({
      data: agents.map((agent) => {
        const found = standing.get(agent.id);
        return {
          ...agent,
          verified: found?.verified ?? false,
          reputation: found?.reputation ?? null,
        };
      }),
      nextCursor: result.rows.length > query.limit ? agents.at(-1)?.id : null,
    });
  }),
);

// The agent's latest reputation snapshot with its Merkle proof and onchain anchor, so anyone can
// check the score against Robinhood Chain without trusting Liege.
agentsRouter.get(
  "/:slug/reputation-proof",
  asyncRoute(async (request, response) => {
    const slug = z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .parse(request.params.slug);
    const found = await db.query<{ id: string }>(
      "SELECT id FROM agents WHERE slug = $1 AND active",
      [slug],
    );
    if (!found.rowCount)
      throw new ApiError(404, "agent_not_found", "No active agent exists with that slug.");
    const proof = await reputationProof(found.rows[0].id);
    if (!proof)
      throw new ApiError(
        404,
        "reputation_not_anchored",
        "This agent has no recorded outcomes to anchor yet.",
      );
    response.json({ data: proof });
  }),
);

// The key an agent signs its deliverables with, so anyone can check a signature on a receipt.
agentsRouter.get(
  "/:agent/signing-key",
  asyncRoute(async (request, response) => {
    const slug = z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .parse(request.params.agent);
    const found = await db.query<{ signing_public_key: string | null; signing_key_added_at: Date }>(
      "SELECT signing_public_key, signing_key_added_at FROM agents WHERE slug = $1 AND active",
      [slug],
    );
    if (!found.rowCount)
      throw new ApiError(404, "agent_not_found", "No active agent exists with that slug.");
    const key = found.rows[0].signing_public_key;
    if (!key)
      throw new ApiError(404, "signing_key_not_set", "This agent does not sign its deliverables.");
    response.json({
      data: {
        algorithm: "Ed25519",
        publicKey: key,
        fingerprint: keyFingerprint(key),
        addedAt: found.rows[0].signing_key_added_at,
      },
    });
  }),
);

// The agent's owner, or its own runtime, publishes the key. Old signatures keep the key they used.
agentsRouter.put(
  "/:agent/signing-key",
  requireAuth,
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agent);
    const input = z.object({ publicKey: z.string().trim() }).parse(request.body);
    if (!isEd25519PublicKey(input.publicKey))
      throw new ApiError(
        422,
        "invalid_signing_key",
        "Send a base64 Ed25519 public key (32 bytes).",
      );
    const runtime = request.runtimeAuth;
    if (
      runtime &&
      (!runtime.agentIds.includes(agentId) || !runtime.scopes.includes("deliverables:write"))
    )
      throw new ApiError(
        403,
        "runtime_scope_denied",
        "This runtime token cannot act for this agent.",
      );
    const updated = await db.query<{ slug: string }>(
      `UPDATE agents SET signing_public_key = $3,
         signing_key_added_at = CASE WHEN signing_public_key IS DISTINCT FROM $3 THEN now() ELSE signing_key_added_at END
       WHERE id = $1 AND owner_id = $2 AND active RETURNING slug`,
      [agentId, request.auth!.userId, input.publicKey],
    );
    if (!updated.rowCount)
      throw new ApiError(404, "agent_not_found", "No active agent of yours has that id.");
    await audit(db, {
      actorId: request.auth!.userId,
      action: "agent.signing_key_set",
      targetType: "agent",
      targetId: agentId,
      requestId: request.requestId,
      metadata: { fingerprint: keyFingerprint(input.publicKey) },
    });
    response.json({
      data: {
        algorithm: "Ed25519",
        publicKey: input.publicKey,
        fingerprint: keyFingerprint(input.publicKey),
      },
    });
  }),
);

// A live badge owners can embed in a README or site: verification and the recorded track record.
agentsRouter.get(
  "/:slug/badge.svg",
  asyncRoute(async (request, response) => {
    const slug = z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .parse(request.params.slug);
    const found = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE slug = $1 AND active",
      [slug],
    );
    if (!found.rowCount)
      throw new ApiError(404, "agent_not_found", "No active agent exists with that slug.");
    const standing = (await agentStanding([found.rows[0].id])).get(found.rows[0].id);
    response
      .type("image/svg+xml")
      .set("cache-control", "public, max-age=300")
      .send(renderBadge(badgeMessage(standing), Boolean(standing?.verified), found.rows[0].name));
  }),
);

agentsRouter.get(
  "/:slug/reputation",
  asyncRoute(async (request, response) => {
    const slug = z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .parse(request.params.slug);

    const agentResult = await db.query(
      `SELECT a.id, a.slug, a.name, a.category, a.reputation_score, a.created_at,
              u.wallet_address AS owner_wallet,
              COALESCE(acc.status, 'active') AS account_status
       FROM agents a
       JOIN users u ON u.id = a.owner_id
       LEFT JOIN agent_accounts acc ON acc.agent_id = a.id
       WHERE a.slug = $1 AND a.active`,
      [slug],
    );

    if (!agentResult.rowCount) {
      throw new ApiError(404, "agent_not_found", "No active agent exists with that slug.");
    }

    const agent = agentResult.rows[0];

    const [
      jobStatsResult,
      revisionStatsResult,
      disputeStatsResult,
      serviceStatsResult,
      mandateStatsResult,
      bonusStatsResult,
    ] = await Promise.all([
      db.query(
        `SELECT
            COUNT(*)::int AS total_jobs,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_jobs,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired_jobs,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_jobs,
            COUNT(*) FILTER (WHERE status IN ('open', 'funded', 'submitted'))::int AS active_jobs,
            AVG(EXTRACT(EPOCH FROM (submitted_at - funded_at))) FILTER (WHERE status = 'completed' AND submitted_at IS NOT NULL AND funded_at IS NOT NULL) AS avg_turnaround_seconds,
            COUNT(*) FILTER (WHERE status = 'completed' AND submitted_at IS NOT NULL AND submitted_at <= deadline_at)::int AS on_time_jobs,
            MAX(settled_at) FILTER (WHERE status = 'completed') AS last_completed_at,
            COALESCE(SUM(CASE WHEN settlement_asset = 'usdg' AND status = 'completed' THEN COALESCE(budget_amount, budget_usdg, 0) ELSE 0 END), 0) AS total_settled_usdg,
            COALESCE(SUM(CASE WHEN settlement_asset = 'liege' AND status = 'completed' THEN COALESCE(budget_amount, 0) ELSE 0 END), 0) AS total_settled_liege
          FROM jobs
          WHERE agent_id = $1`,
        [agent.id],
      ),
      db.query(
        `SELECT
            COUNT(*)::int AS revision_requests,
            COUNT(DISTINCT e.job_id)::int AS jobs_with_revisions
           FROM job_events e
           JOIN jobs j ON j.id = e.job_id
           WHERE j.agent_id = $1 AND e.event_type = 'job.revision_requested'`,
        [agent.id],
      ),
      db.query(
        `SELECT
            COUNT(d.id)::int AS total_disputes,
            COUNT(d.id) FILTER (WHERE d.status = 'resolved_provider')::int AS disputes_won,
            COUNT(d.id) FILTER (WHERE d.status = 'resolved_client')::int AS disputes_lost
          FROM disputes d
          JOIN jobs j ON j.id = d.job_id
          WHERE j.agent_id = $1`,
        [agent.id],
      ),
      db.query(
        `SELECT
            COUNT(*)::int AS total_services,
            MIN(sla_minutes)::int AS min_sla_minutes,
            ARRAY_AGG(DISTINCT service_type) FILTER (WHERE service_type IS NOT NULL) AS service_types
          FROM commerce_services
          WHERE agent_id = $1 AND active = true`,
        [agent.id],
      ),
      db.query(
        `SELECT
            COUNT(*)::int AS total_mandates,
            COUNT(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS active_mandates
          FROM agent_mandates
          WHERE agent_id = $1`,
        [agent.id],
      ),
      db.query(
        `SELECT COUNT(*)::int AS bonuses,
            COUNT(DISTINCT client_id)::int AS clients,
            COALESCE(trim_scale(SUM(amount) FILTER (WHERE asset = 'usdg')), 0)::text AS usdg,
            COALESCE(trim_scale(SUM(amount) FILTER (WHERE asset = 'liege')), 0)::text AS liege
          FROM job_bonuses WHERE agent_id = $1`,
        [agent.id],
      ),
    ]);

    const jobStats = jobStatsResult.rows[0];
    const revisionStats = revisionStatsResult.rows[0];
    const disputeStats = disputeStatsResult.rows[0];
    const serviceStats = serviceStatsResult.rows[0];
    const mandateStats = mandateStatsResult.rows[0];

    const completedJobs = Number(jobStats.completed_jobs ?? 0);
    const closedJobs =
      completedJobs + Number(jobStats.rejected_jobs ?? 0) + Number(jobStats.expired_jobs ?? 0);
    const completionRate = closedJobs > 0 ? Number((completedJobs / closedJobs).toFixed(4)) : null;

    const avgTurnaroundSeconds =
      jobStats.avg_turnaround_seconds != null ? Number(jobStats.avg_turnaround_seconds) : null;
    const avgTurnaroundMinutes =
      avgTurnaroundSeconds != null ? Number((avgTurnaroundSeconds / 60).toFixed(2)) : null;

    const onTimeJobs = Number(jobStats.on_time_jobs ?? 0);
    const onTimeDeliveryRate =
      completedJobs > 0 ? Number((onTimeJobs / completedJobs).toFixed(4)) : null;

    const totalJobs = Number(jobStats.total_jobs ?? 0);
    const totalDisputes = Number(disputeStats.total_disputes ?? 0);
    const disputeRate = totalJobs > 0 ? Number((totalDisputes / totalJobs).toFixed(4)) : 0.0;

    const standing = (await agentStanding([agent.id])).get(agent.id);
    const auditPayload = {
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        category: agent.category,
        ownerWallet: agent.owner_wallet,
        reputationScore: Number(agent.reputation_score ?? 0),
        reputationScoreStatus: "not_scored",
        accountStatus: agent.account_status,
        registeredAt: new Date(agent.created_at).toISOString(),
        verifiedSuperAgent: standing?.verified ?? false,
        verifiedAt: standing?.verifiedAt ?? null,
      },
      reputation: {
        ...(standing?.reputation ?? {
          status: "not_scored",
          score: null,
          outcomes: 0,
          reason: "No recorded outcomes.",
        }),
        method: {
          minimumOutcomes: MIN_SCORED_JOBS,
          weights: REPUTATION_WEIGHTS,
          smoothing: "laplace",
        },
      },
      // Bonuses clients chose to add after accepting work: paid from their own balance.
      bonuses: {
        count: Number(bonusStatsResult.rows[0].bonuses),
        fromClients: Number(bonusStatsResult.rows[0].clients),
        totalUsdg: bonusStatsResult.rows[0].usdg,
        totalLiege: bonusStatsResult.rows[0].liege,
      },
      settlement: {
        currency: "USDG",
        totalSettledUsdg: String(Number(jobStats.total_settled_usdg).toFixed(6)),
        totalSettledLiege: String(Number(jobStats.total_settled_liege).toFixed(6)),
        network: "robinhood_chain",
        chainId: 4663,
      },
      jobs: {
        total: totalJobs,
        completed: completedJobs,
        rejected: Number(jobStats.rejected_jobs ?? 0),
        expired: Number(jobStats.expired_jobs ?? 0),
        cancelled: Number(jobStats.cancelled_jobs ?? 0),
        active: Number(jobStats.active_jobs ?? 0),
        completionRate,
      },
      performance: {
        source: "liege_job_lifecycle",
        completedJobs,
        onTimeCompletedJobs: onTimeJobs,
        onTimeDeliveryRate,
        rejectedJobs: Number(jobStats.rejected_jobs ?? 0),
        expiredJobs: Number(jobStats.expired_jobs ?? 0),
        cancelledJobs: Number(jobStats.cancelled_jobs ?? 0),
        jobsWithRevisionRequests: Number(revisionStats.jobs_with_revisions ?? 0),
        revisionRequests: Number(revisionStats.revision_requests ?? 0),
        lastCompletedAt: jobStats.last_completed_at
          ? new Date(jobStats.last_completed_at).toISOString()
          : null,
      },
      sla: {
        avgTurnaroundMinutes,
        onTimeJobs,
        onTimeDeliveryRate,
        minCatalogSlaMinutes:
          serviceStats.min_sla_minutes != null ? Number(serviceStats.min_sla_minutes) : null,
      },
      disputes: {
        total: totalDisputes,
        resolvedProvider: Number(disputeStats.disputes_won ?? 0),
        resolvedClient: Number(disputeStats.disputes_lost ?? 0),
        disputeRate,
      },
      catalog: {
        activeServicesCount: Number(serviceStats.total_services ?? 0),
        serviceTypes: (serviceStats.service_types as string[] | null) ?? [],
      },
      mandates: {
        activeCount: Number(mandateStats.active_mandates ?? 0),
        totalIssued: Number(mandateStats.total_mandates ?? 0),
      },
    };

    const auditDigest = createHash("sha256").update(canonical(auditPayload)).digest("hex");

    response.json({
      data: {
        ...auditPayload,
        auditDigest,
        auditedAt: new Date().toISOString(),
      },
    });
  }),
);

agentsRouter.get(
  "/:slug",
  asyncRoute(async (request, response) => {
    const result = await db.query(
      `SELECT a.*, u.wallet_address AS owner_wallet FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.slug = $1 AND a.active`,
      [request.params.slug],
    );
    if (!result.rowCount)
      throw new ApiError(404, "agent_not_found", "No active agent exists with that slug.");
    response.json({ data: result.rows[0] });
  }),
);

agentsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = createAgent.parse(request.body);
    const result = await db.query(
      `INSERT INTO agents (owner_id, slug, name, description, category, capabilities, settlement_assets, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        request.auth!.userId,
        input.slug,
        input.name,
        input.description,
        input.category,
        JSON.stringify(input.capabilities),
        input.settlementAssets,
        JSON.stringify(input.metadata),
      ],
    );
    response.status(201).json({ data: result.rows[0] });
  }),
);

// Owner-only and irreversible from the API: the agent leaves the marketplace, its services stop
// selling, and its Super Agent enrollment is disabled. Job history is kept.
agentsRouter.post(
  "/:id/deactivate",
  requireAuth,
  asyncRoute(async (request, response) => {
    if (request.runtimeAuth)
      throw new ApiError(
        403,
        "runtime_token_not_allowed",
        "Runtime tokens cannot deactivate agents. Sign in with the owner wallet.",
      );
    const agentId = z.string().uuid().parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const agent = await client.query<{ id: string; slug: string; name: string }>(
        "SELECT id, slug, name FROM agents WHERE id = $1 AND owner_id = $2 AND active FOR UPDATE",
        [agentId, request.auth!.userId],
      );
      if (!agent.rowCount)
        throw new ApiError(404, "agent_not_found", "No active agent you own has that ID.");
      const activeJobs = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM jobs WHERE agent_id = $1 AND status IN ('open', 'funded', 'submitted')",
        [agentId],
      );
      if (activeJobs.rows[0].count > 0)
        throw new ApiError(
          409,
          "agent_has_active_jobs",
          "Finish, settle, or let expire this agent's open, funded, and submitted jobs before deactivating it.",
        );
      const result = await client.query(
        "UPDATE agents SET active = false, updated_at = now() WHERE id = $1 RETURNING *",
        [agentId],
      );
      const services = await client.query(
        "UPDATE commerce_services SET active = false, updated_at = now() WHERE agent_id = $1 AND active",
        [agentId],
      );
      const enrollments = await client.query(
        "UPDATE superagent_enrollments SET enabled = false, updated_at = now() WHERE agent_id = $1 AND enabled",
        [agentId],
      );
      await audit(client, {
        actorId: request.auth!.userId,
        action: "agent.deactivated",
        targetType: "agent",
        targetId: agentId,
        requestId: request.requestId,
        metadata: {
          slug: agent.rows[0].slug,
          servicesDeactivated: services.rowCount ?? 0,
          superAgentEnrollmentsDisabled: enrollments.rowCount ?? 0,
        },
      });
      await client.query("COMMIT");
      response.json({ data: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
