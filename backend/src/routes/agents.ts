import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { canonical } from "../agentActions.js";
import { db } from "../db/index.js";
import { requireAuth } from "../auth.js";
import { ApiError, asyncRoute } from "../http.js";

const createAgent = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  name: z.string().min(2).max(80),
  description: z.string().min(20).max(2000),
  category: z.string().min(2).max(80),
  capabilities: z.array(z.string().min(1).max(80)).max(20).default([]),
  metadata: z.record(z.unknown()).default({}),
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
      `SELECT a.id, a.slug, a.name, a.description, a.category, a.capabilities, a.reputation_score, a.created_at, u.wallet_address AS owner_wallet
     FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.active AND ($1::text IS NULL OR a.category = $1)
       AND ($2::uuid IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [query.category ?? null, query.cursor ?? null, query.limit + 1],
    );
    const agents = result.rows.slice(0, query.limit);
    response.json({
      data: agents,
      nextCursor: result.rows.length > query.limit ? agents.at(-1)?.id : null,
    });
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

    const [jobStatsResult, disputeStatsResult, serviceStatsResult, mandateStatsResult] =
      await Promise.all([
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
            COALESCE(SUM(CASE WHEN settlement_asset = 'usdg' AND status = 'completed' THEN COALESCE(budget_amount, budget_usdg, 0) ELSE 0 END), 0) AS total_settled_usdg,
            COALESCE(SUM(CASE WHEN settlement_asset = 'liege' AND status = 'completed' THEN COALESCE(budget_amount, 0) ELSE 0 END), 0) AS total_settled_liege
          FROM jobs
          WHERE agent_id = $1`,
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
      ]);

    const jobStats = jobStatsResult.rows[0];
    const disputeStats = disputeStatsResult.rows[0];
    const serviceStats = serviceStatsResult.rows[0];
    const mandateStats = mandateStatsResult.rows[0];

    const completedJobs = Number(jobStats.completed_jobs ?? 0);
    const closedJobs =
      completedJobs + Number(jobStats.rejected_jobs ?? 0) + Number(jobStats.expired_jobs ?? 0);
    const completionRate = closedJobs > 0 ? Number((completedJobs / closedJobs).toFixed(4)) : 1.0;

    const avgTurnaroundSeconds =
      jobStats.avg_turnaround_seconds != null ? Number(jobStats.avg_turnaround_seconds) : null;
    const avgTurnaroundMinutes =
      avgTurnaroundSeconds != null ? Number((avgTurnaroundSeconds / 60).toFixed(2)) : null;

    const onTimeJobs = Number(jobStats.on_time_jobs ?? 0);
    const onTimeDeliveryRate =
      completedJobs > 0 ? Number((onTimeJobs / completedJobs).toFixed(4)) : 1.0;

    const totalJobs = Number(jobStats.total_jobs ?? 0);
    const totalDisputes = Number(disputeStats.total_disputes ?? 0);
    const disputeRate = totalJobs > 0 ? Number((totalDisputes / totalJobs).toFixed(4)) : 0.0;

    const auditPayload = {
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        category: agent.category,
        ownerWallet: agent.owner_wallet,
        reputationScore: Number(agent.reputation_score ?? 0),
        accountStatus: agent.account_status,
        registeredAt: new Date(agent.created_at).toISOString(),
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
      `INSERT INTO agents (owner_id, slug, name, description, category, capabilities, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        request.auth!.userId,
        input.slug,
        input.name,
        input.description,
        input.category,
        JSON.stringify(input.capabilities),
        JSON.stringify(input.metadata),
      ],
    );
    response.status(201).json({ data: result.rows[0] });
  }),
);
