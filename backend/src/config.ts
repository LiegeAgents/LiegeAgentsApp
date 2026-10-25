import "dotenv/config";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";

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
    // Shared with the Vercel proxies in front of the API. A request carrying it may name the
    // end user's IP for rate limiting; without it every proxied user shares one budget.
    LIEGE_PROXY_SECRET: z.string().min(32).optional(),
    // How often the API looks for due recurring Super Agent jobs; 0 disables the in-process
    // scheduler (POST /v1/cron/run-schedules still works).
    SUPERAGENT_SCHEDULES_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
    // Polls Robinhood Chain for onchain trigger events; 0 disables it. No calls without active triggers.
    CHAIN_TRIGGERS_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
    DATABASE_URL: z.string().url(),
    RHC_ID: z.coerce.number().int().positive().default(4663),
    RHC_RPC_URL: z.string().url(),
    ESCROW_MODE: z
      .enum(["ledger", "onchain", "veilora"])
      .default(
        process.env.VEILORA_ESCROW_FACTORY_ADDRESS
          ? "veilora"
          : process.env.USDG_TOKEN_ADDRESS
            ? "onchain"
            : "ledger",
      ),
    VEILORA_ESCROW_FACTORY_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    VEILORA_ESCROW_FACTORY_V2_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    LIEGE_ESCROW_SIGNER_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    LIEGE_ESCROW_SIGNER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    // A dedicated wallet that writes receipt Merkle roots to Robinhood Chain and pays their gas.
    // Without it, receipts are still built and wait for anchoring.
    // Optional and never fatal: a blank or malformed key only switches anchoring off.
    RECEIPT_ANCHOR_PRIVATE_KEY: z
      .string()
      .optional()
      .transform((value) => {
        const key = value?.trim();
        if (!key) return undefined;
        if (/^0x[0-9a-fA-F]{64}$/.test(key)) return key;
        console.warn(
          "RECEIPT_ANCHOR_PRIVATE_KEY is not a 0x-prefixed 32-byte key; receipts will not be anchored.",
        );
        return undefined;
      }),
    // How often the API builds receipts and anchors a batch; 0 leaves it to the cron route.
    RECEIPT_ANCHOR_INTERVAL_MS: z.coerce.number().int().min(0).default(600_000),
    // Challenge window for Liege-ledger jobs: hours between an evaluator's decision and payout
    // (0 pays out at once), and the challenger's bond as basis points of the job budget.
    CHALLENGE_WINDOW_HOURS: z.coerce.number().int().min(0).max(168).default(0),
    CHALLENGE_BOND_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000),
    // Pay-per-call: the highest price an agent may set per call, and how long a call may run.
    INSTANT_CALL_MAX_USDG: z.coerce.number().positive().default(5),
    INSTANT_CALL_MAX_LIEGE: z.coerce.number().positive().default(25_000),
    INSTANT_CALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
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
    LIEGE_STAKING_POOL_ADDRESS: z.preprocess(
      (value) =>
        value === "" || value === undefined
          ? (source.LIEGE_STAKING_POOL_WALLET_PUBLIC_KEY ?? undefined)
          : value,
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .optional(),
    ),
    LIEGE_STAKING_POOL_PRIVATE_KEY: z.preprocess(
      (value) =>
        value === "" || value === undefined
          ? (source.LIEGE_STAKING_POOL_WALLET_PRIVATE_KEY ?? undefined)
          : value,
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .optional(),
    ),
    LIEGE_STAKING_ENABLED: z.enum(["true", "false"]).default("false"),
    LIEGE_STAKING_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(2),
    ESCROW_GAS_RESERVE_USD: z.coerce.number().positive().default(1),
    ESCROW_QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    ESCROW_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(1),
    AUTH_DOMAIN: z.string().min(1).default("localhost"),
    AUTH_URI: z.string().url().default("http://localhost"),
    MAX_ADMIN_CREDIT_USDG: z.coerce.number().positive().finite().default(10_000),
    MAX_ADMIN_CREDIT_DAILY_USDG: z.coerce.number().positive().finite().default(50_000),
    // Operators may override this value before creating new LIEGE jobs.
    SELF_SETTLEMENT_LIMIT_LIEGE: z.coerce.number().positive().finite().default(25_000_000),
    AUTH_TOKEN_PEPPER: z.string().min(32).optional(),
    DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
    DATA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),
    CRON_SECRET: z.string().min(24).optional(),
    // Shared only with the separately deployed MCP service. It authenticates
    // service-to-service calls; it never authenticates an end user or wallet.
    MCP_INTERNAL_API_TOKEN: z.string().min(32).optional(),
    MCP_PUBLIC_URL: z.string().url().default("https://mcp.liegeagents.com"),
    // Where GitHub sends trigger webhooks; shown to clients when they connect a repository.
    PUBLIC_API_URL: z.string().url().default("https://api.liegeagents.com"),
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
    RESEND_API_KEY: z.string().min(1).optional(),
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
if (env.ESCROW_MODE !== "ledger" && (!env.USDG_TOKEN_ADDRESS || !env.DATA_ENCRYPTION_KEY)) {
  throw new Error(
    "USDG_TOKEN_ADDRESS and DATA_ENCRYPTION_KEY are required for on-chain job escrow.",
  );
}
if (
  env.ESCROW_MODE !== "ledger" &&
  (!env.VEILORA_ESCROW_FACTORY_ADDRESS ||
    !env.VEILORA_ESCROW_FACTORY_V2_ADDRESS ||
    !env.LIEGE_ESCROW_SIGNER_ADDRESS ||
    !env.LIEGE_ESCROW_SIGNER_PRIVATE_KEY)
) {
  throw new Error(
    "Both Veilora factory addresses and the Liege escrow signer are required for per-job escrow routing.",
  );
}
if (
  env.ESCROW_MODE !== "ledger" &&
  env.LIEGE_ESCROW_SIGNER_ADDRESS &&
  env.LIEGE_ESCROW_SIGNER_PRIVATE_KEY &&
  privateKeyToAccount(
    env.LIEGE_ESCROW_SIGNER_PRIVATE_KEY as `0x${string}`,
  ).address.toLowerCase() !== env.LIEGE_ESCROW_SIGNER_ADDRESS.toLowerCase()
) {
  throw new Error("LIEGE_ESCROW_SIGNER_PRIVATE_KEY does not match LIEGE_ESCROW_SIGNER_ADDRESS.");
}
if (
  env.X402_FACILITATOR_URL &&
  new URL(env.X402_FACILITATOR_URL).protocol !== "https:" &&
  env.NODE_ENV === "production"
) {
  throw new Error("X402_FACILITATOR_URL must use HTTPS in production.");
}

export { env };
