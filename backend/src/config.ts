import "dotenv/config";
import { z } from "zod";

const source =
  process.env.NODE_ENV === "test"
    ? {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgresql://liege:liege@localhost:5432/liege_test",
        RHC_RPC_URL: process.env.RHC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
      }
    : process.env;

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    TRUST_PROXY: z.string().min(1).default("1"),
    DATABASE_URL: z.string().url(),
    RHC_ID: z.coerce.number().int().positive().default(4663),
    RHC_RPC_URL: z.string().url(),
    ESCROW_MODE: z
      .enum(["ledger", "onchain"])
      .default(process.env.USDG_TOKEN_ADDRESS ? "onchain" : "ledger"),
    USDG_TOKEN_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    USDG_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
    USDG_TOKEN_NAME: z.string().min(1).default("Global Dollar"),
    USDG_TOKEN_VERSION: z.string().min(1).default("1"),
    X402_FACILITATOR_URL: z.string().url().optional(),
    X402_MAX_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    X_BOT_ENABLED: z.enum(["true", "false"]).default("false"),
    X_BOT_HANDLE: z.string().min(1).optional(),
    X_ACCESS_TOKEN: z.string().min(1).optional(),
    X_CLIENT_ID: z.string().min(1).optional(),
    X_CLIENT_SECRET: z.string().min(1).optional(),
    X_REFRESH_TOKEN: z.string().min(1).optional(),
    X_OAUTH_REDIRECT_URI: z.string().url().optional(),
    X_BOT_MENTIONS_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(15_000)
      .max(3_600_000)
      .default(30_000),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().min(1).default("qwen/qwen3-32b"),
    SUPERAGENTS_URL: z.string().url().default("https://superagents.liegeagents.com"),
    LIEGE_TOKEN_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .default("0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645"),
    LIEGE_DECIMALS: z.coerce.number().int().min(0).max(18).default(18),
    ESCROW_GAS_RESERVE_USD: z.coerce.number().positive().default(1),
    ESCROW_QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    ESCROW_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(1),
    AUTH_DOMAIN: z.string().min(1).default("localhost"),
    AUTH_URI: z.string().url().default("http://localhost"),
    MAX_ADMIN_CREDIT_USDG: z.coerce.number().positive().finite().default(10_000),
    MAX_ADMIN_CREDIT_DAILY_USDG: z.coerce.number().positive().finite().default(50_000),
    // Keep the default independent-review threshold aligned across settlement assets.
    // Operators may set a different value before creating new LIEGE jobs.
    SELF_SETTLEMENT_LIMIT_LIEGE: z.coerce.number().positive().finite().default(50),
    AUTH_TOKEN_PEPPER: z.string().min(32).optional(),
    DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
    DATA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),
    CRON_SECRET: z.string().min(24).optional(),
    // Shared only with the separately deployed MCP service. It authenticates
    // service-to-service calls; it never authenticates an end user or wallet.
    MCP_INTERNAL_API_TOKEN: z.string().min(32).optional(),
    MCP_PUBLIC_URL: z.string().url().default("https://mcp.liegeagents.com"),
    RUNNER_WORKER_URL: z.string().url().optional(),
    RUNNER_WORKER_TOKEN: z.string().min(32).optional(),
    // Virtuals ACP is an opt-in provider adapter. Credentials are never required
    // when the adapter is disabled, so existing deployments remain unchanged.
    ACP_ENABLED: z.enum(["true", "false"]).default("false"),
    ACP_CHAIN_ID: z.coerce.number().int().positive().default(4663),
    ACP_EVM_WALLET_ID: z.string().min(1).optional(),
    ACP_AGENT_WALLET_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    ACP_SIGNER_PRIVATE_KEY: z.string().min(1).optional(),
    ACP_BUILDER_CODE: z.string().min(1).optional(),
    ACP_DEFAULT_PRICE_USD: z.coerce.number().positive().finite().default(0.01),
    ADMIN_WALLET_ADDRESSES: z.string().optional(),
    MASTER_ADMIN_CODE: z.string().min(12).optional(),
  })
  .parse(source);

export const adminWallets = new Set(
  (env.ADMIN_WALLET_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

if (
  env.NODE_ENV === "production" &&
  (!env.AUTH_TOKEN_PEPPER ||
    !env.CRON_SECRET ||
    !adminWallets.size ||
    env.AUTH_DOMAIN === "localhost" ||
    env.AUTH_URI === "http://localhost" ||
    !env.MCP_INTERNAL_API_TOKEN ||
    !env.RUNNER_WORKER_URL ||
    !env.RUNNER_WORKER_TOKEN ||
    !env.MASTER_ADMIN_CODE)
) {
  throw new Error(
    "AUTH_TOKEN_PEPPER, CRON_SECRET, ADMIN_WALLET_ADDRESSES, MASTER_ADMIN_CODE, AUTH_DOMAIN, AUTH_URI, MCP_INTERNAL_API_TOKEN, RUNNER_WORKER_URL, and RUNNER_WORKER_TOKEN are required in production.",
  );
}
if (env.X_BOT_ENABLED === "true" && (!env.X_ACCESS_TOKEN || !env.X_BOT_HANDLE)) {
  throw new Error("X_ACCESS_TOKEN and X_BOT_HANDLE are required when X_BOT_ENABLED=true.");
}
if (
  env.NODE_ENV === "production" &&
  (!env.DATA_ENCRYPTION_KEY || env.DATA_ENCRYPTION_KEY === env.AUTH_TOKEN_PEPPER)
) {
  throw new Error(
    "A DATA_ENCRYPTION_KEY separate from AUTH_TOKEN_PEPPER is required in production.",
  );
}
if (env.ESCROW_MODE === "onchain" && (!env.USDG_TOKEN_ADDRESS || !env.DATA_ENCRYPTION_KEY)) {
  throw new Error(
    "USDG_TOKEN_ADDRESS and DATA_ENCRYPTION_KEY are required when ESCROW_MODE=onchain.",
  );
}
if (
  env.X402_FACILITATOR_URL &&
  new URL(env.X402_FACILITATOR_URL).protocol !== "https:" &&
  env.NODE_ENV === "production"
) {
  throw new Error("X402_FACILITATOR_URL must use HTTPS in production.");
}

export { env };
