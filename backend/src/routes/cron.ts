import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config.js'
import { db } from '../db/index.js'
import { ApiError, asyncRoute } from '../http.js'

export const cronRouter = Router()

cronRouter.use((request, _response, next) => {
  if (!env.CRON_SECRET || request.header('x-cron-secret') !== env.CRON_SECRET) return next(new ApiError(401, 'invalid_cron_secret', 'A valid cron secret is required.'))
  next()
})

cronRouter.post('/expire-jobs', asyncRoute(async (request, response) => {
  const { idempotencyKey } = z.object({ idempotencyKey: z.string().min(8).max(200) }).parse(request.body)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const prior = await client.query('SELECT result FROM cron_runs WHERE name = $1 AND idempotency_key = $2 FOR UPDATE', ['expire-jobs', idempotencyKey])
    if (prior.rowCount) { await client.query('COMMIT'); return response.json({ data: prior.rows[0].result, replayed: true }) }
    const expired = await client.query("UPDATE jobs SET status = 'expired', settled_at = now(), updated_at = now() WHERE status IN ('open', 'funded', 'submitted') AND expires_at <= now() RETURNING id")
    if (expired.rowCount) await client.query("INSERT INTO job_events (job_id, event_type) SELECT id, 'job.expired' FROM jobs WHERE id = ANY($1::uuid[])", [expired.rows.map((row) => row.id)])
    const result = { expired: expired.rowCount ?? 0 }
    await client.query('INSERT INTO cron_runs (name, idempotency_key, result) VALUES ($1,$2,$3)', ['expire-jobs', idempotencyKey, JSON.stringify(result)])
    await client.query('COMMIT')
    response.json({ data: result, replayed: false })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))
