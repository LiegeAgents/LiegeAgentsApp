import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("pay-per-call from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let reply: { status: number; body: Json } = { status: 201, body: { data: {} } };

  beforeEach(() => {
    calls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      return Response.json(reply.body, { status: reply.status });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("makes a call with an idempotency key and returns the answer", async () => {
    reply = { status: 201, body: { data: { status: "succeeded", output: "No major red flags." } } };
    const result = await execute(["calls", "make", "agent-1", "--input", "Check 0xabc"]);
    expect(result).toMatchObject({ status: "succeeded", output: "No major red flags." });
    expect(calls[0]).toMatchObject({ path: "/v1/super-agents/calls", method: "POST" });
    expect(calls[0].body).toMatchObject({
      agentId: "agent-1",
      input: "Check 0xabc",
      settlementAsset: "usdg",
    });
    expect(String(calls[0].body!.idempotencyKey)).toStartWith("cli-");

    await execute([
      "calls",
      "make",
      "agent-1",
      "--input",
      "Hi",
      "--asset",
      "liege",
      "--key",
      "k-12345678",
    ]);
    expect(calls[1].body).toMatchObject({ settlementAsset: "liege", idempotencyKey: "k-12345678" });
    await expect(execute(["calls", "make", "agent-1"])).rejects.toThrow("--input is required");
  });

  test("a refunded call surfaces the reason", async () => {
    reply = {
      status: 502,
      body: {
        error: {
          code: "call_failed",
          message: "The agent declined: No address. You were not charged.",
        },
      },
    };
    await expect(execute(["calls", "make", "agent-1", "--input", "Is it safe?"])).rejects.toThrow(
      "You were not charged.",
    );
  });

  test("owners set and turn off call prices", async () => {
    reply = { status: 200, body: { data: {} } };
    await execute(["calls", "price", "agent-1", "--usdg", "0.25", "--liege", "off"]);
    expect(calls[0]).toMatchObject({
      path: "/v1/super-agents/enrollments/agent-1/call-prices",
      method: "PUT",
      body: { usdg: 0.25, liege: null },
    });
    await expect(execute(["calls", "price", "agent-1"])).rejects.toThrow("Set --usdg");
    await execute(["calls", "list", "--limit", "5"]);
    expect(calls.at(-1)!.path).toBe("/v1/super-agents/calls?limit=5");
  });
});
