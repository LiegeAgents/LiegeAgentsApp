import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { decryptPayload, encryptPayload, payloadDigest } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

export const legionsRouter = Router();
const decimalBps = z.coerce.number().int().min(1).max(10_000);
const assignmentInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(3).max(160),
  brief: z.string().min(1).max(100_000),
  allocationBps: decimalBps,
});

async function leadJob(jobId: string, userId: string, lock = false) {
  const result = await db.query<{ id: string; agent_id: string; status: string }>(
    `SELECT j.id, j.agent_id, j.status FROM jobs j JOIN agents a ON a.id = j.agent_id
     WHERE j.id = $1 AND a.owner_id = $2${lock ? " FOR UPDATE OF j" : ""}`,
    [jobId, userId],
  );
  if (!result.rowCount) throw new ApiError(403, "not_legion_lead", "Only the parent job's agent can manage its Liege-ion.");
  return result.rows[0];
}

legionsRouter.get(
  "/:id/legion",
  requireAuth,
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `SELECT l.id AS legion_id, l.name, l.job_id, la.id, la.agent_id, a.owner_id AS member_owner_id, a.name AS agent_name,
              la.title, la.allocation_bps, la.status, la.created_at, la.accepted_at, la.submitted_at
       FROM legions l JOIN legion_assignments la ON la.legion_id = l.id JOIN agents a ON a.id = la.agent_id
       JOIN jobs j ON j.id = l.job_id JOIN agents lead ON lead.id = j.agent_id
       WHERE l.job_id = $1 AND (j.client_id = $2 OR lead.owner_id = $2 OR a.owner_id = $2 OR j.evaluator_id = $2)
       ORDER BY la.created_at`,
      [jobId, request.auth!.userId],
    );
    if (!result.rowCount) return response.json({ data: null });
    const first = result.rows[0] as Record<string, unknown>;
    response.json({ data: { id: first.legion_id, jobId: first.job_id, name: first.name, assignments: result.rows.map(({ legion_id: _l, job_id: _j, name: _n, ...assignment }) => assignment) } });
  }),
);

legionsRouter.post(
  "/:id/legion/assignments",
  requireAuth,
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.id);
    const input = assignmentInput.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<{ id: string; agent_id: string; status: string }>(
        `SELECT j.id, j.agent_id, j.status FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 AND a.owner_id = $2 FOR UPDATE OF j`, [jobId, request.auth!.userId],
      );
      if (!job.rowCount) throw new ApiError(403, "not_legion_lead", "Only the parent job's agent can manage its Liege-ion.");
      if (!["open", "funded"].includes(job.rows[0].status)) throw new ApiError(409, "legion_closed", "Assignments can only be added before the parent job is submitted.");
      if (input.agentId === job.rows[0].agent_id) throw new ApiError(422, "legion_lead_assignment", "The lead agent already receives the unallocated share.");
      const agent = await client.query("SELECT id FROM agents WHERE id = $1 AND active", [input.agentId]);
      if (!agent.rowCount) throw new ApiError(404, "agent_not_found", "The delegated agent is unavailable.");
      const legion = await client.query<{ id: string }>(
        `INSERT INTO legions (job_id, lead_agent_id, name) VALUES ($1,$2,$3)
         ON CONFLICT (job_id) DO UPDATE SET updated_at = now() RETURNING id`,
        [jobId, job.rows[0].agent_id, "Liege-ion"],
      );
      const reserved = await client.query<{ total: string }>("SELECT COALESCE(sum(allocation_bps), 0) AS total FROM legion_assignments WHERE legion_id = $1 AND status <> 'declined'", [legion.rows[0].id]);
      if (Number(reserved.rows[0].total) + input.allocationBps > 10_000) throw new ApiError(422, "legion_budget_exceeded", "Delegated shares cannot exceed 100% of the parent budget.");
      const assignmentId = crypto.randomUUID();
      const created = await client.query(
        `INSERT INTO legion_assignments (id, legion_id, agent_id, title, brief_ciphertext, brief_hash, allocation_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, agent_id, title, allocation_bps, status, created_at`,
        [assignmentId, legion.rows[0].id, input.agentId, input.title, encryptPayload(input.brief, `legion:${assignmentId}:brief`), payloadDigest(input.brief), input.allocationBps],
      );
      await client.query("INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1,$2,'legion.assignment_proposed',$3)", [jobId, request.auth!.userId, JSON.stringify({ assignmentId, agentId: input.agentId, allocationBps: input.allocationBps })]);
      await client.query("COMMIT");
      response.status(201).json({ data: created.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }),
);

legionsRouter.post(
  "/:id/legion/assignments/:assignmentId/:action",
  requireAuth,
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.id);
    const assignmentId = z.string().uuid().parse(request.params.assignmentId);
    const action = z.enum(["accept", "decline", "submit"]).parse(request.params.action);
    const deliverable = action === "submit" ? z.object({ deliverable: z.string().min(1).max(100_000) }).parse(request.body).deliverable : null;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const assignment = await client.query<{ status: string }>(
        `SELECT la.status FROM legion_assignments la JOIN legions l ON l.id = la.legion_id JOIN agents a ON a.id = la.agent_id
         WHERE la.id = $1 AND l.job_id = $2 AND a.owner_id = $3 FOR UPDATE`, [assignmentId, jobId, request.auth!.userId],
      );
      if (!assignment.rowCount) throw new ApiError(403, "not_legion_member", "Only the delegated agent can respond to this assignment.");
      const expected = action === "accept" || action === "decline" ? "proposed" : "accepted";
      if (assignment.rows[0].status !== expected) throw new ApiError(409, "invalid_legion_transition", "This assignment cannot take that action now.");
      const result = await client.query(
        action === "submit"
          ? "UPDATE legion_assignments SET status = 'submitted', deliverable_ciphertext = $3, deliverable_hash = $4, submitted_at = now() WHERE id = $1 AND legion_id IN (SELECT id FROM legions WHERE job_id = $2) RETURNING id, agent_id, title, allocation_bps, status, submitted_at"
          : `UPDATE legion_assignments SET status = '${action === "accept" ? "accepted" : "declined"}', ${action === "accept" ? "accepted_at" : "declined_at"} = now() WHERE id = $1 AND legion_id IN (SELECT id FROM legions WHERE job_id = $2) RETURNING id, agent_id, title, allocation_bps, status`,
        action === "submit" ? [assignmentId, jobId, encryptPayload(deliverable!, `legion:${assignmentId}:deliverable`), payloadDigest(deliverable!)] : [assignmentId, jobId],
      );
      await client.query("INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)", [jobId, request.auth!.userId, `legion.assignment_${action}ed`, JSON.stringify({ assignmentId })]);
      await client.query("COMMIT");
      response.json({ data: result.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }),
);

legionsRouter.get(
  "/:id/legion/assignments/:assignmentId/payload",
  requireAuth,
  asyncRoute(async (request, response) => {
    const jobId = z.string().uuid().parse(request.params.id); const assignmentId = z.string().uuid().parse(request.params.assignmentId);
    const row = await db.query<{ brief_ciphertext: string; deliverable_ciphertext: string | null; member_owner_id: string; lead_owner_id: string }>(
      `SELECT la.brief_ciphertext, la.deliverable_ciphertext, member.owner_id AS member_owner_id, lead.owner_id AS lead_owner_id
       FROM legion_assignments la JOIN legions l ON l.id = la.legion_id JOIN agents member ON member.id = la.agent_id
       JOIN agents lead ON lead.id = l.lead_agent_id WHERE la.id = $1 AND l.job_id = $2`, [assignmentId, jobId]);
    if (!row.rowCount || ![row.rows[0].member_owner_id, row.rows[0].lead_owner_id].includes(request.auth!.userId)) throw new ApiError(403, "legion_payload_forbidden", "This private assignment is unavailable to this account.");
    response.json({ data: { brief: decryptPayload(row.rows[0].brief_ciphertext, `legion:${assignmentId}:brief`), deliverable: row.rows[0].deliverable_ciphertext ? decryptPayload(row.rows[0].deliverable_ciphertext, `legion:${assignmentId}:deliverable`) : null } });
  }),
);
