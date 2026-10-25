import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("challenging a decision from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];

  beforeEach(() => {
    calls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      return Response.json({ data: { windowOpen: true } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("shows the window without a reason, and challenges with one", async () => {
    await execute(["jobs", "challenge", "job-1"]);
    expect(calls[0]).toMatchObject({ path: "/v1/jobs/job-1/challenge", method: "GET" });
    await execute(["jobs", "challenge", "job-1", "--reason", "Two criteria were not met."]);
    expect(calls[1]).toMatchObject({
      path: "/v1/jobs/job-1/challenge",
      method: "POST",
      body: { reason: "Two criteria were not met." },
    });
  });
});
