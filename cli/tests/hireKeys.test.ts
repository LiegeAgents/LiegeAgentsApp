import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("hiring keys from the CLI", () => {
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
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ data: { token: "lmh_secret" } }, { status: 201 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("creates, lists, and revokes a key", async () => {
    const created = await execute([
      "hire-keys",
      "create",
      "Research bot",
      "--max-per-hire",
      "5",
      "--daily",
      "20",
      "--days",
      "7",
    ]);
    expect(created).toMatchObject({ token: "lmh_secret" });
    expect(calls[0]).toMatchObject({ path: "/v1/mcp/hire-keys", method: "POST" });
    expect(calls[0].body).toEqual({
      name: "Research bot",
      maxBudgetPerHire: 5,
      dailyBudget: 20,
      expiresInDays: 7,
    });
    await expect(execute(["hire-keys", "create", "Research bot"])).rejects.toThrow(
      "--max-per-hire and --daily",
    );
    await execute(["hire-keys", "list"]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/mcp/hire-keys", method: "GET" });
    expect(await execute(["hire-keys", "revoke", "key-1"])).toEqual({ revoked: "key-1" });
    expect(calls.at(-1)).toMatchObject({ path: "/v1/mcp/hire-keys/key-1", method: "DELETE" });
  });
});
