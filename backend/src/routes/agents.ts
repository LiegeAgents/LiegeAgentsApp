import { Router } from "express";
import { z } from "zod";
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
