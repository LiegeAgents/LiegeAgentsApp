import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { db } from '../db/index.js'
import { requireAuth } from '../auth.js'
import { ApiError, asyncRoute } from '../http.js'
import { escrowAccount, transfer, userBalance } from '../ledger.js'
import { decryptPayload, encryptPayload, hashPayload } from '../crypto.js'
import { audit } from '../audit.js'

const jobInput = z.object({
  agentId: z.string().uuid(), evaluatorId: z.string().uuid().optional(),
  kind: z.enum(['standard', 'trade_stock_token', 'manage_vault', 'subscription', 'fund_transfer']).default('standard'),
  title: z.string().min(3).max(160), brief: z.string().min(1).max(100_000).optional(), briefCiphertext: z.string().min(1).max(100_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(20), budgetUsdg: z.coerce.number().positive(),
  evaluatorFeeUsdg: z.coerce.number().min(0).default(0), deadlineAt: z.coerce.date(), expiresAt: z.coerce.date(),
  strategyPolicy: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => { if (!value.brief && !value.briefCiphertext) ctx.addIssue({ code: 'custom', message: 'brief is required.' }); if (value.expiresAt < value.deadlineAt) ctx.addIssue({ code: 'custom', message: 'expiresAt cannot precede deadlineAt.' }) })

const event = async (jobId: string, actorId: string | null, eventType: string, payload: object = {}) =>
  db.query('INSERT INTO job_events (job_id, actor_id, event_type, payload) VALUES ($1, $2, $3, $4)', [jobId, actorId, eventType, JSON.stringify(payload)])

export const jobsRouter = Router()

jobsRouter.get('/', requireAuth, asyncRoute(async (request, response) => {
  const query = z.object({ status: z.enum(['open', 'funded', 'submitted', 'completed', 'rejected', 'expired', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query)
  const result = await db.query(
    `SELECT j.*, a.name AS agent_name, a.slug AS agent_slug FROM jobs j JOIN agents a ON a.id = j.agent_id
     WHERE (j.client_id = $1 OR a.owner_id = $1 OR j.evaluator_id = $1) AND ($2::job_status IS NULL OR j.status = $2)
     ORDER BY j.created_at DESC LIMIT $3`, [request.auth!.userId, query.status ?? null, query.limit],
  )
  response.json({ data: result.rows })
}))

jobsRouter.get('/:id', requireAuth, asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id)
  const result = await db.query(`SELECT j.*, a.owner_id AS provider_id, a.name AS agent_name, a.slug AS agent_slug,
      s.deliverable_ciphertext, s.evidence AS submission_evidence, s.created_at AS delivery_created_at,
      e.outcome AS evaluation_outcome, e.rationale_ciphertext, e.created_at AS evaluation_created_at
    FROM jobs j JOIN agents a ON a.id = j.agent_id
    LEFT JOIN submissions s ON s.job_id = j.id
    LEFT JOIN evaluations e ON e.job_id = j.id
    WHERE j.id = $1 AND (j.client_id = $2 OR a.owner_id = $2 OR j.evaluator_id = $2)`, [id, request.auth!.userId])
  if (!result.rowCount) throw new ApiError(404, 'job_not_found', 'This job does not exist or is not available to this account.')
  const job = result.rows[0]
  response.json({ data: {
    ...job,
    brief: decryptPayload(job.brief_ciphertext), brief_ciphertext: undefined,
    submission: job.deliverable_ciphertext ? { deliverable: decryptPayload(job.deliverable_ciphertext), evidence: job.submission_evidence ?? [], createdAt: job.delivery_created_at } : null,
    evaluation: job.rationale_ciphertext ? { outcome: job.evaluation_outcome, rationale: decryptPayload(job.rationale_ciphertext), createdAt: job.evaluation_created_at } : null,
    deliverable_ciphertext: undefined, rationale_ciphertext: undefined, submission_evidence: undefined, delivery_created_at: undefined, evaluation_outcome: undefined, evaluation_created_at: undefined,
  } })
}))

jobsRouter.post('/', requireAuth, asyncRoute(async (request, response) => {
  const input = jobInput.parse(request.body)
  const agent = await db.query<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = $1 AND active', [input.agentId])
  if (!agent.rowCount) throw new ApiError(404, 'agent_not_found', 'The selected agent is unavailable.')
  if (agent.rows[0].owner_id === request.auth!.userId) throw new ApiError(422, 'self_hire_not_allowed', 'An owner cannot open a job for their own agent.')
  if (input.evaluatorId) {
    const evaluator = await db.query<{ stake_usdg: string; active: boolean }>(`SELECT ep.active, COALESCE(sum(lp.amount_usdg), 0) AS stake_usdg FROM evaluator_profiles ep
      LEFT JOIN ledger_accounts la ON la.user_id = ep.user_id AND la.kind = 'stake' LEFT JOIN ledger_postings lp ON lp.account_id = la.id
      WHERE ep.user_id = $1 GROUP BY ep.active`, [input.evaluatorId])
    if (!evaluator.rowCount || !evaluator.rows[0].active || Number(evaluator.rows[0].stake_usdg) < 5000) throw new ApiError(422, 'evaluator_ineligible', 'The selected evaluator must have an active profile with at least 5,000 USDG staked.')
    if (input.budgetUsdg > Number(evaluator.rows[0].stake_usdg) / 5) throw new ApiError(422, 'evaluator_capacity_exceeded', 'A job cannot exceed one fifth of its evaluator’s stake.')
    if (input.evaluatorId === request.auth!.userId && input.budgetUsdg >= 50) throw new ApiError(422, 'self_evaluation_limit', 'Client self-evaluation is allowed only for jobs below 50 USDG.')
    if (input.evaluatorId === agent.rows[0].owner_id) throw new ApiError(422, 'provider_cannot_evaluate', 'An agent owner cannot evaluate their own job.')
  }
  const privateBrief = input.brief ?? input.briefCiphertext!
  const result = await db.query(
    `INSERT INTO jobs (client_id, agent_id, evaluator_id, kind, title, brief_ciphertext, brief_hash, acceptance_criteria, budget_usdg, evaluator_fee_usdg, deadline_at, expires_at, strategy_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [request.auth!.userId, input.agentId, input.evaluatorId ?? null, input.kind, input.title, encryptPayload(privateBrief), hashPayload(privateBrief), JSON.stringify(input.acceptanceCriteria), input.budgetUsdg, input.evaluatorFeeUsdg, input.deadlineAt, input.expiresAt, input.strategyPolicy ? JSON.stringify(input.strategyPolicy) : null],
  )
  await event(result.rows[0].id, request.auth!.userId, 'job.opened')
  await audit(db, { actorId: request.auth!.userId, action: 'job.opened', targetType: 'job', targetId: result.rows[0].id, requestId: request.requestId })
  response.status(201).json({ data: result.rows[0] })
}))

async function transition(client: PoolClient, request: Parameters<typeof asyncRoute>[0] extends (request: infer R, ...args: never[]) => unknown ? R : never, next: 'funded' | 'submitted' | 'completed' | 'rejected') {
  const id = z.string().uuid().parse(request.params.id)
  const job = await client.query('SELECT j.*, a.owner_id AS provider_id FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE', [id])
  if (!job.rowCount) throw new ApiError(404, 'job_not_found', 'This job does not exist.')
  const value = job.rows[0]
  const allowed: Record<string, string[]> = { funded: ['open'], submitted: ['funded'], completed: ['submitted'], rejected: ['submitted'] }
  if (!allowed[next].includes(value.status)) throw new ApiError(409, 'invalid_job_transition', `A ${value.status} job cannot move to ${next}.`)
  if (next === 'funded' && value.client_id !== request.auth!.userId) throw new ApiError(403, 'not_client', 'Only the client can record funding.')
  if (next === 'submitted' && value.provider_id !== request.auth!.userId) throw new ApiError(403, 'not_provider', 'Only the agent owner can submit work.')
  if (['completed', 'rejected'].includes(next) && value.evaluator_id !== request.auth!.userId) throw new ApiError(403, 'not_evaluator', 'Only the assigned evaluator can settle this job.')
  return value
}

jobsRouter.post('/:id/fund', requireAuth, asyncRoute(async (request, response) => {
  const client = await db.connect(); try { await client.query('BEGIN'); const job = await transition(client, request, 'funded'); const total = Number(job.budget_usdg) + Number(job.evaluator_fee_usdg); const available = await userBalance(client, request.auth!.userId); if (available.amount < total) throw new ApiError(422, 'insufficient_available_balance', 'Your available USDG balance cannot fund this job.'); await transfer(client, { reference: `job-fund:${job.id}`, type: 'job_fund', from: available.accountId, to: await escrowAccount(client, job.id), amount: total, createdBy: request.auth!.userId, metadata: { jobId: job.id } }); const result = await client.query("UPDATE jobs SET status = 'funded', funded_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [job.id]); await client.query('INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)', [job.id, request.auth!.userId, 'job.funded']); await client.query('COMMIT'); response.json({ data: result.rows[0] }) } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

jobsRouter.post('/:id/submit', requireAuth, asyncRoute(async (request, response) => {
  const input = z.object({ deliverable: z.string().min(1).max(100_000).optional(), deliverableCiphertext: z.string().min(1).max(100_000).optional(), evidence: z.array(z.string().url()).max(20).default([]) }).refine(value => Boolean(value.deliverable || value.deliverableCiphertext), 'deliverable is required.').parse(request.body)
  const payload = input.deliverable ?? input.deliverableCiphertext!
  const client = await db.connect(); try { await client.query('BEGIN'); const job = await transition(client, request, 'submitted'); await client.query('INSERT INTO submissions (job_id, provider_id, deliverable_ciphertext, deliverable_hash, evidence) VALUES ($1,$2,$3,$4,$5)', [job.id, request.auth!.userId, encryptPayload(payload), hashPayload(payload), JSON.stringify(input.evidence)]); const result = await client.query("UPDATE jobs SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [job.id]); await client.query('INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)', [job.id, request.auth!.userId, 'job.submitted']); await client.query('COMMIT'); response.json({ data: result.rows[0] }) } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

jobsRouter.post('/:id/evaluate', requireAuth, asyncRoute(async (request, response) => {
  const input = z.object({ outcome: z.enum(['accepted', 'rejected']), rationale: z.string().min(1).max(100_000).optional(), rationaleCiphertext: z.string().min(1).max(100_000).optional() }).refine(value => Boolean(value.rationale || value.rationaleCiphertext), 'rationale is required.').parse(request.body)
  const rationale = input.rationale ?? input.rationaleCiphertext!
  const target = input.outcome === 'accepted' ? 'completed' : 'rejected'
  const client = await db.connect(); try { await client.query('BEGIN'); const job = await transition(client, request, target); const escrow = await escrowAccount(client, job.id); const total = Number(job.budget_usdg) + Number(job.evaluator_fee_usdg); if (target === 'completed') { const provider = await userBalance(client, job.provider_id); const evaluator = await userBalance(client, request.auth!.userId); await transfer(client, { reference: `job-settle-provider:${job.id}`, type: 'job_settlement', from: escrow, to: provider.accountId, amount: Number(job.budget_usdg), createdBy: request.auth!.userId, metadata: { jobId: job.id } }); if (Number(job.evaluator_fee_usdg) > 0) await transfer(client, { reference: `job-settle-evaluator:${job.id}`, type: 'evaluator_fee', from: escrow, to: evaluator.accountId, amount: Number(job.evaluator_fee_usdg), createdBy: request.auth!.userId, metadata: { jobId: job.id } }) } else { const clientBalance = await userBalance(client, job.client_id); await transfer(client, { reference: `job-refund:${job.id}`, type: 'job_refund', from: escrow, to: clientBalance.accountId, amount: total, createdBy: request.auth!.userId, metadata: { jobId: job.id } }) }; await client.query('INSERT INTO evaluations (job_id, evaluator_id, outcome, rationale_ciphertext, rationale_hash) VALUES ($1,$2,$3,$4,$5)', [job.id, request.auth!.userId, input.outcome, encryptPayload(rationale), hashPayload(rationale)]); const result = await client.query(`UPDATE jobs SET status = '${target}', settled_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [job.id]); await client.query('INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)', [job.id, request.auth!.userId, `job.${target}`]); await client.query('COMMIT'); response.json({ data: result.rows[0] }) } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))
