import { expect, test } from "bun:test";
import { assertSafeWebhookUrl } from "../src/webhooks.js";
import { databaseTransportProblem } from "../src/config.js";

test("remote production databases require certificate verification", () => {
  const secure = "postgresql://user:pass@db.example.com:5432/liege?sslmode=verify-full";
  const insecure = "postgresql://user:pass@db.example.com:5432/liege?sslmode=require";
  expect(databaseTransportProblem(secure)).toBeNull();
  expect(databaseTransportProblem(insecure)).toContain("sslmode=verify-full");
});

test("production refuses to boot without a remote runner worker", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", "await import('./src/config.ts')"],
    cwd: new URL("../", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/liege?sslmode=verify-full",
      RHC_RPC_URL: "https://rpc.example.com",
      ESCROW_MODE: "ledger",
      AUTH_TOKEN_PEPPER: "a".repeat(32),
      DATA_ENCRYPTION_KEY: "b".repeat(32),
      CRON_SECRET: "c".repeat(24),
      MCP_INTERNAL_API_TOKEN: "d".repeat(32),
      ADMIN_WALLET_ADDRESSES: "0x1111111111111111111111111111111111111111",
      AUTH_DOMAIN: "api.example.com",
      AUTH_URI: "https://app.example.com",
      RUNNER_WORKER_URL: "",
      RUNNER_WORKER_TOKEN: "",
    },
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("RUNNER_WORKER_URL");
});

test("webhooks refuse loopback, link-local, and private addresses", async () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.1/hook",
    "https://[::1]/hook",
    "https://[::ffff:169.254.169.254]/hook",
  ])
    await expect(assertSafeWebhookUrl(url)).rejects.toThrow("private or link-local");
});
