import express from 'express'
import { z } from 'zod'
import { issueNonce, createSession, revokeSession } from './auth.js'
import { env } from './config.js'
import { agentsRouter } from './routes/agents.js'
import { jobsRouter } from './routes/jobs.js'
import { cronRouter } from './routes/cron.js'
import { evaluatorsRouter } from './routes/evaluators.js'
import { adminRouter } from './routes/admin.js'
import { accountRouter } from './routes/account.js'
import { ApiError, asyncRoute, errorHandler } from './http.js'
import { rateLimit, requestContext } from './operations.js'

export const app = express()
export const healthPayload = () => ({ status: 'ok', timestamp: new Date().toISOString(), version: process.env.npm_package_version ?? '0.1.0' })
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '128kb' }))
app.use(requestContext)
app.use(rateLimit)
app.use((request, response, next) => {
  const origin = request.header('origin')
  if (origin && origin === env.CORS_ORIGIN) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Cron-Secret')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  next()
})
app.get('/health', (_request, response) => response.json(healthPayload()))
app.get('/health/ready', asyncRoute(async (_request, response) => {
  await (await import('./db/index.js')).db.query('SELECT 1')
  response.json({ status: 'ready', timestamp: new Date().toISOString() })
}))
app.post('/v1/auth/nonce', asyncRoute(async (request, response) => {
  const { address } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(request.body)
  response.status(201).json({ data: await issueNonce(address) })
}))
app.post('/v1/auth/verify', asyncRoute(async (request, response) => {
  const { address, nonce, signature } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(request.body)
  response.json({ data: await createSession(address, nonce, signature as `0x${string}`) })
}))
app.post('/v1/auth/logout', revokeSession)
app.use('/v1', accountRouter)
app.use('/v1/agents', agentsRouter)
app.use('/v1/jobs', jobsRouter)
app.use('/v1/evaluators', evaluatorsRouter)
app.use('/v1/admin', adminRouter)
app.use('/v1/cron', cronRouter)
app.use((_request, _response, next) => next(new ApiError(404, 'not_found', 'Route not found.')))
app.use(errorHandler)
