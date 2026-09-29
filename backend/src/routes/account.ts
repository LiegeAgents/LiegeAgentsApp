import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db } from '../db/index.js'
import { userBalance } from '../ledger.js'
import { asyncRoute } from '../http.js'

export const accountRouter = Router()

accountRouter.get('/me', requireAuth, asyncRoute(async (request, response) => {
  const user = await db.query('SELECT id, wallet_address, display_name, created_at FROM users WHERE id = $1', [request.auth!.userId])
  const client = await db.connect()
  try {
    const [available, stake] = await Promise.all([userBalance(client, request.auth!.userId), userBalance(client, request.auth!.userId, 'stake')])
    response.json({ data: { ...user.rows[0], balances: { availableUsdg: available.amount, stakeUsdg: stake.amount } } })
  } finally { client.release() }
}))

accountRouter.get('/me/ledger', requireAuth, asyncRoute(async (request, response) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query)
  const result = await db.query(
    `SELECT lt.id, lt.reference, lt.type, lt.metadata, lt.created_at, sum(lp.amount_usdg) FILTER (WHERE la.user_id = $1) AS net_usdg
     FROM ledger_transactions lt JOIN ledger_postings lp ON lp.transaction_id = lt.id JOIN ledger_accounts la ON la.id = lp.account_id
     WHERE la.user_id = $1 GROUP BY lt.id ORDER BY lt.created_at DESC LIMIT $2`, [request.auth!.userId, query.limit],
  )
  response.json({ data: result.rows })
}))
