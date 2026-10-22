import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("onchain triggers from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];

  beforeEach(() => {
    calls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      return Response.json({ data: { id: "chain-1" } }, { status: 201 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("creates transfer and event triggers and controls them", async () => {
    const token = "0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645";
    await execute([
      "superagents",
      "onchain",
      "create",
      "--agent-id",
      "a1",
      "--token",
      token,
      "--min",
      "1000000",
      "--budget",
      "3",
      "--cap",
      "15",
      "--cooldown",
      "15",
      "--auto-fund",
    ]);
    expect(calls[0]).toMatchObject({ path: "/v1/super-agents/chain-triggers", method: "POST" });
    expect(calls[0].body).toEqual({
      agentId: "a1",
      kind: "token_transfer",
      contract: token,
      minAmount: 1000000,
      cooldownMinutes: 15,
      settlementAsset: "usdg",
      budgetAmount: 3,
      spendCap: 15,
      autoFund: true,
      source: "cli",
    });
    await execute([
      "superagents",
      "onchain",
      "create",
      "--agent-id",
      "a1",
      "--contract",
      token,
      "--event",
      "OwnershipTransferred(address indexed a, address indexed b)",
      "--budget",
      "3",
      "--cap",
      "9",
    ]);
    expect(calls[1].body).toMatchObject({
      kind: "contract_event",
      eventSignature: "OwnershipTransferred(address indexed a, address indexed b)",
    });
    await expect(
      execute([
        "superagents",
        "onchain",
        "create",
        "--agent-id",
        "a1",
        "--contract",
        token,
        "--budget",
        "3",
        "--cap",
        "9",
      ]),
    ).rejects.toThrow("--event");
    await execute(["superagents", "onchain", "list"]);
    await execute(["superagents", "onchain", "pause", "chain-1"]);
    await execute(["superagents", "onchain", "cancel", "chain-1"]);
    expect(calls.slice(2).map((call) => [call.method, call.path])).toEqual([
      ["GET", "/v1/super-agents/chain-triggers"],
      ["POST", "/v1/super-agents/chain-triggers/chain-1/pause"],
      ["DELETE", "/v1/super-agents/chain-triggers/chain-1"],
    ]);
  });
});
