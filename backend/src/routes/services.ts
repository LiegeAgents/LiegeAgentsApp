import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

const serviceInput = z
  .object({
    agentId: z.string().uuid(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().min(2).max(120),
    description: z.string().min(20).max(4000),
    serviceType: z.enum(["tool", "data", "skill"]),
    executionMode: z.enum(["manual", "sandboxed_runner"]).default("manual"),
    priceUsd: z.coerce.number().positive().finite(),
    // The lowest price the agent accepts when a client counters; private to the owner.
    minPriceUsd: z.coerce.number().positive().finite().optional(),
    slaMinutes: z.coerce.number().int().min(1).max(10080),
    requirementsSchema: z.record(z.unknown()).default({}),
    deliverableSchema: z.record(z.unknown()).default({}),
    // Legacy service registrations omitted settlementAssets; preserve both rails for them.
    settlementAssets: z.array(z.string()).min(1).default(["usdg", "liege"]),
  })
  .transform((value, ctx) => {
    if (value.minPriceUsd !== undefined && value.minPriceUsd > value.priceUsd)
      ctx.addIssue({
        code: "custom",
        path: ["minPriceUsd"],
        message: "The lowest price cannot be above the listed price.",
      });
    const assets = [...new Set(value.settlementAssets.map((asset) => asset.trim().toLowerCase()))];
    if (assets.some((asset) => asset !== "usdg" && asset !== "liege")) {
      ctx.addIssue({
        code: "custom",
        path: ["settlementAssets"],
        message: "Settlement assets must be usdg or liege.",
      });
    }
    return { ...value, settlementAssets: assets };
  });

export const servicesRouter = Router();

servicesRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        agentId: z.string().uuid().optional(),
        type: z.enum(["tool", "data", "skill"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const result = await db.query(
      `SELECT s.id, s.agent_id, s.slug, s.name, s.description, s.service_type, s.execution_mode,
        s.settlement_assets,
        s.price_usd, s.sla_minutes, s.requirements_schema, s.deliverable_schema,
        s.created_at, s.updated_at, a.slug AS agent_slug, a.name AS agent_name
       FROM commerce_services s JOIN agents a ON a.id = s.agent_id
       WHERE s.active AND a.active AND ($1::uuid IS NULL OR s.agent_id = $1)
         AND ($2::text IS NULL OR s.service_type = $2)
       ORDER BY s.created_at DESC LIMIT $3`,
      [query.agentId ?? null, query.type ?? null, query.limit],
    );
    response.json({ data: result.rows });
  }),
);

servicesRouter.get(
  "/:agentId/:slug",
  asyncRoute(async (request, response) => {
    const agentId = z.string().uuid().parse(request.params.agentId);
    const slug = z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .parse(request.params.slug);
    const result = await db.query(
      `SELECT s.id, s.agent_id, s.slug, s.name, s.description, s.service_type, s.execution_mode,
        s.settlement_assets,
        s.price_usd, s.sla_minutes, s.requirements_schema, s.deliverable_schema,
        s.created_at, s.updated_at, a.slug AS agent_slug, a.name AS agent_name
       FROM commerce_services s JOIN agents a ON a.id = s.agent_id
       WHERE s.agent_id = $1 AND s.slug = $2 AND s.active AND a.active`,
      [agentId, slug],
    );
    if (!result.rowCount)
      throw new ApiError(404, "service_not_found", "No active service exists with that slug.");
    response.json({ data: result.rows[0] });
  }),
);

servicesRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = serviceInput.parse(request.body);
    const owner = await db.query<{ id: string; settlement_assets: string[] }>(
      "SELECT id, settlement_assets FROM agents WHERE id = $1 AND owner_id = $2",
      [input.agentId, request.auth!.userId],
    );
    if (!owner.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    if (!input.settlementAssets.every((asset) => owner.rows[0].settlement_assets.includes(asset)))
      throw new ApiError(
        422,
        "settlement_asset_not_supported",
        "The service can only accept assets enabled on its agent profile.",
      );
    const result = await db.query(
      `INSERT INTO commerce_services
       (agent_id, slug, name, description, service_type, execution_mode, price_usd, sla_minutes, requirements_schema, deliverable_schema, settlement_assets, min_price_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        input.agentId,
        input.slug,
        input.name,
        input.description,
        input.serviceType,
        input.executionMode,
        input.priceUsd,
        input.slaMinutes,
        JSON.stringify(input.requirementsSchema),
        JSON.stringify(input.deliverableSchema),
        input.settlementAssets,
        input.minPriceUsd ?? null,
      ],
    );
    response.status(201).json({ data: result.rows[0] });
  }),
);

// The owner sets, changes, or clears (null) the lowest price the service accepts on a counter.
servicesRouter.patch(
  "/:id/min-price",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const { minPriceUsd } = z
      .object({ minPriceUsd: z.number().positive().finite().nullable() })
      .parse(request.body);
    const found = await db.query<{ price_usd: string }>(
      `SELECT s.price_usd FROM commerce_services s JOIN agents a ON a.id = s.agent_id
       WHERE s.id = $1 AND a.owner_id = $2`,
      [id, request.auth!.userId],
    );
    if (!found.rowCount)
      throw new ApiError(404, "service_not_found", "This service is not owned by your account.");
    if (minPriceUsd !== null && minPriceUsd > Number(found.rows[0].price_usd))
      throw new ApiError(
        422,
        "min_price_above_list",
        "The lowest price cannot be above the listed price.",
      );
    const updated = await db.query(
      "UPDATE commerce_services SET min_price_usd = $2 WHERE id = $1 RETURNING id, price_usd, min_price_usd",
      [id, minPriceUsd],
    );
    response.json({ data: updated.rows[0] });
  }),
);
