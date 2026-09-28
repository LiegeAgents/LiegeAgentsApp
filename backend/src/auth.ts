import { createHash, randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { verifyMessage } from 'viem'
import { db } from './db/index.js'
import { env } from './config.js'
import { ApiError, asyncRoute } from './http.js'

const SESSION_DAYS = 7
const normalizeAddress = (address: string) => address.toLowerCase()
const digest = (value: string) => createHash('sha256').update(`${env.AUTH_TOKEN_PEPPER ?? ''}:${value}`).digest('hex')

export const loginMessage = (address: string, nonce: string, issuedAt: Date) =>
  `Liege wants you to sign in with your wallet:\n${address}\n\nNonce: ${nonce}\nIssued At: ${issuedAt.toISOString()}\nChain ID: ${env.RHC_ID}`

export async function issueNonce(address: string) {
  const walletAddress = normalizeAddress(address)
  const nonce = randomBytes(24).toString('base64url')
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000)
  await db.query('UPDATE auth_nonces SET consumed_at = now() WHERE wallet_address = $1 AND consumed_at IS NULL', [walletAddress])
  await db.query('INSERT INTO auth_nonces (wallet_address, nonce, issued_at, expires_at) VALUES ($1, $2, $3, $4)', [walletAddress, nonce, issuedAt, expiresAt])
  return { nonce, message: loginMessage(walletAddress, nonce, issuedAt), expiresAt }
}

export async function createSession(address: string, nonce: string, signature: `0x${string}`) {
  const walletAddress = normalizeAddress(address)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ expires_at: Date; issued_at: Date }>(
      'SELECT expires_at, issued_at FROM auth_nonces WHERE wallet_address = $1 AND nonce = $2 AND consumed_at IS NULL FOR UPDATE', [walletAddress, nonce],
    )
    const record = result.rows[0]
    if (!record || record.expires_at <= new Date()) throw new ApiError(401, 'invalid_nonce', 'This sign-in request has expired. Request a new nonce.')
    const valid = await verifyMessage({ address: walletAddress as `0x${string}`, message: loginMessage(walletAddress, nonce, record.issued_at), signature })
    if (!valid) throw new ApiError(401, 'invalid_signature', 'The signature does not match this wallet or sign-in request.')
    await client.query('UPDATE auth_nonces SET consumed_at = now() WHERE wallet_address = $1 AND nonce = $2 AND consumed_at IS NULL', [walletAddress, nonce])
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (wallet_address) VALUES ($1)
       ON CONFLICT (wallet_address) DO UPDATE SET updated_at = now() RETURNING id`, [walletAddress],
    )
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)
    await client.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [user.rows[0].id, digest(token), expiresAt])
    await client.query('COMMIT')
    return { token, expiresAt, userId: user.rows[0].id, walletAddress }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

declare global { namespace Express { interface Request { auth?: { userId: string; walletAddress: string } } } }

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  try {
    const bearer = request.header('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (!bearer) throw new ApiError(401, 'unauthenticated', 'A bearer session token is required.')
    const session = await db.query<{ user_id: string; wallet_address: string }>(
      `SELECT s.user_id, u.wallet_address FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [digest(bearer)],
    )
    if (!session.rowCount) throw new ApiError(401, 'invalid_session', 'This session is invalid or expired.')
    request.auth = { userId: session.rows[0].user_id, walletAddress: session.rows[0].wallet_address }
    next()
  } catch (error) { next(error) }
}

export const revokeSession = asyncRoute(async (request: Request, response: Response) => {
  const bearer = request.header('authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if (bearer) await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [digest(bearer)])
  response.status(204).end()
})
