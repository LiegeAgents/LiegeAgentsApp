import { privateKeyToAccount } from "viem/accounts";

// A fixed test-only key, allowlisted as the administrator wallet.
export const adminKey = `0x${"a1".repeat(32)}` as const;

// The config module reads these at import time, so they are set before any test loads it.
process.env.CRON_SECRET ??= "integration-test-cron-secret";
process.env.ADMIN_WALLET_ADDRESSES ??= privateKeyToAccount(adminKey).address;
process.env.MCP_INTERNAL_API_TOKEN ??= "integration-test-mcp-service-token";
