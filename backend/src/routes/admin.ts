import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { requireAdmin } from '../admin.js'
import { db } from '../db/index.js'
import { creditUser, setStake, userBalance } from '../ledger.js'
import { asyncRoute } from '../http.js'

const transferInput = z.object({ userId: z.string().uuid(), amountUsdg: z.coerce.number().positive(), reference: z.string().min(8).max(200) })
export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

adminRouter.post('/ledger/credit', asyncRoute(async (request, response) => {
  const input = transferInput.parse(request.body)
  const client = await db.connect()
  try { await client.query('BEGIN'); await creditUser(client, input.userId, input.amountUsdg, request.auth!.userId, input.reference); await client.query('COMMIT'); response.status(201).json({ data: await userBalance(client, input.userId) }) }
  catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

adminRouter.post('/evaluators/stake', asyncRoute(async (request, response) => {
  const input = z.object({ userId: z.string().uuid(), stakeUsdg: z.coerce.number().min(0), reference: z.string().min(8).max(200) }).parse(request.body)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const profile = await client.query('SELECT 1 FROM evaluator_profiles WHERE user_id = $1', [input.userId])
    if (!profile.rowCount) await client.query('INSERT INTO evaluator_profiles (user_id) VALUES ($1)', [input.userId])
    await setStake(client, input.userId, input.stakeUsdg, request.auth!.userId, input.reference)
    await client.query('UPDATE evaluator_profiles SET stake_usdg = $1, updated_at = now() WHERE user_id = $2', [input.stakeUsdg, input.userId])
    await client.query('COMMIT')
    response.json({ data: { userId: input.userId, stakeUsdg: input.stakeUsdg } })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))
