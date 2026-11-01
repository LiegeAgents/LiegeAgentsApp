import { Router } from "express";
import { z } from "zod";
import { approvalRules } from "../approvalRules.js";
import { requireAuth } from "../auth.js";
import { decryptPayload, encryptPayload } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

/**
 * Job templates: a client saves a job they open often under a name and fills the job form from
 * it. The brief is encrypted at rest; saving under an existing name replaces that template.
 */
export const jobTemplatesRouter = Router();

const MAX_TEMPLATES = 50;
const briefContext = (id: string) => `template:${id}:brief`;

const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(3).max(160),
  brief: z.string().trim().min(1).max(100_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  approvalRules: approvalRules.optional(),
  agentId: z.string().uuid().optional(),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  budget: z.number().finite().positive().max(1e12).optional(),
});

type Row = {
  id: string;
  name: string;
  title: string;
  brief_ciphertext: string;
  acceptance_criteria: string[];
  approval_rules: unknown[] | null;
  agent_id: string | null;
  agent_name: string | null;
  settlement_asset: string;
  budget: string | null;
  created_at: Date;
  updated_at: Date;
};

const present = (row: Row) => ({
  id: row.id,
  name: row.name,
  title: row.title,
  brief: decryptPayload(row.brief_ciphertext, briefContext(row.id)),
  acceptanceCriteria: row.acceptance_criteria,
  approvalRules: row.approval_rules,
  agentId: row.agent_id,
  agentName: row.agent_name,
  settlementAsset: row.settlement_asset,
  budget: row.budget,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const columns = `t.id, t.name, t.title, t.brief_ciphertext, t.acceptance_criteria, t.approval_rules,
  t.agent_id, a.name AS agent_name, t.settlement_asset, trim_scale(t.budget)::text AS budget,
  t.created_at, t.updated_at`;

jobTemplatesRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const rows = await db.query<Row>(
      `SELECT ${columns} FROM job_templates t LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.owner_id = $1 ORDER BY t.updated_at DESC`,
      [request.auth!.userId],
    );
    response.json({ data: rows.rows.map(present) });
  }),
);

jobTemplatesRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    if (request.runtimeAuth)
      throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot save templates.");
    const input = templateInput.parse(request.body);
    const userId = request.auth!.userId;
    if (input.agentId) {
      const agent = await db.query("SELECT 1 FROM agents WHERE id = $1 AND active", [
        input.agentId,
      ]);
      if (!agent.rowCount)
        throw new ApiError(404, "agent_not_found", "The selected agent is unavailable.");
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serializes a user's saves so the template cap holds.
      await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM job_templates WHERE owner_id = $1 AND name = $2",
        [userId, input.name],
      );
      let id = existing.rows[0]?.id;
      if (!id) {
        const count = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM job_templates WHERE owner_id = $1",
          [userId],
        );
        if (count.rows[0].n >= MAX_TEMPLATES)
          throw new ApiError(
            409,
            "template_limit",
            `You can keep up to ${MAX_TEMPLATES} templates. Delete one first.`,
          );
        id = (await client.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      }
      await client.query(
        `INSERT INTO job_templates (id, owner_id, name, title, brief_ciphertext, acceptance_criteria,
           approval_rules, agent_id, settlement_asset, budget)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
           brief_ciphertext = EXCLUDED.brief_ciphertext,
           acceptance_criteria = EXCLUDED.acceptance_criteria,
           approval_rules = EXCLUDED.approval_rules, agent_id = EXCLUDED.agent_id,
           settlement_asset = EXCLUDED.settlement_asset, budget = EXCLUDED.budget,
           updated_at = now()`,
        [
          id,
          userId,
          input.name,
          input.title,
          encryptPayload(input.brief, briefContext(id)),
          JSON.stringify(input.acceptanceCriteria),
          input.approvalRules ? JSON.stringify(input.approvalRules) : null,
          input.agentId ?? null,
          input.settlementAsset,
          input.budget ?? null,
        ],
      );
      const saved = await client.query<Row>(
        `SELECT ${columns} FROM job_templates t LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.id = $1`,
        [id],
      );
      await client.query("COMMIT");
      response.status(existing.rowCount ? 200 : 201).json({ data: present(saved.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobTemplatesRouter.delete(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const removed = await db.query("DELETE FROM job_templates WHERE id = $1 AND owner_id = $2", [
      id,
      request.auth!.userId,
    ]);
    if (!removed.rowCount)
      throw new ApiError(404, "template_not_found", "That template does not exist.");
    response.status(204).end();
  }),
);
