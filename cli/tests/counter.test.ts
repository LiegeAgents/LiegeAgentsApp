import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";

type Json = Record<string, unknown>;

describe("counter-offers from the CLI chat", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let output: string[] = [];
  let intents: Json[] = [];

  beforeEach(() => {
    calls = [];
    output = [];
    intents = [
      {
        id: "bbbb2222-0000-0000-0000-000000000000",
        status: "approved",
        parsed: { request: "Old" },
      },
      {
        id: "cccc3333-0000-0000-0000-000000000000",
        status: "pending",
        parsed: { request: "Scan" },
      },
    ];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const data =
        path === "/v1/super-agents/intents"
          ? intents
          : path.endsWith("/counter")
            ? {
                message:
                  "Anna by LiegeAgents can do it for 4 USDG. Approve at that price, or counter once more.",
              }
            : {};
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("/counter answers for the most recent pending proposal", async () => {
    await new ChatSession((line) => output.push(line)).handle("/counter 3");
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/intents/cccc3333-0000-0000-0000-000000000000/counter",
      method: "POST",
      body: { budgetAmount: 3 },
    });
    expect(output.join("\n")).toContain("can do it for 4 USDG");
  });

  test("/counter needs an amount and a pending proposal", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.handle("/counter");
    expect(output.join("\n")).toContain("Usage: /counter <USDG amount> [proposal id]");
    output = [];
    await chat.handle("/counter 3 bbbb");
    expect(output.join("\n")).toContain("No pending proposal to counter");
    expect(calls.some((call) => call.path.endsWith("/counter"))).toBe(false);
  });
});
