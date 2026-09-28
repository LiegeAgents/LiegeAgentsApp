import 'dotenv/config'
import { z } from 'zod'

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  RHC_ID: z.coerce.number().int().positive().default(4663),
  RHC_RPC_URL: z.string().url(),
  AUTH_TOKEN_PEPPER: z.string().min(32).optional(),
  CRON_SECRET: z.string().min(24).optional(),
  ADMIN_WALLET_ADDRESSES: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
}).parse(process.env)

export const adminWallets = new Set((env.ADMIN_WALLET_ADDRESSES ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))

if (env.NODE_ENV === 'production' && (!env.AUTH_TOKEN_PEPPER || !env.CRON_SECRET || !adminWallets.size)) {
  throw new Error('AUTH_TOKEN_PEPPER, CRON_SECRET, and ADMIN_WALLET_ADDRESSES are required in production.')
}

export { env }
