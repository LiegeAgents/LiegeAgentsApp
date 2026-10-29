import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("reviews from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json; auth: string | null }> = [];

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
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ data: { rating: 5 } }, { status: 201 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("reviews a job, replies, and reads an agent's reviews", async () => {
    await execute(["jobs", "review", "job-1", "--rating", "5", "--comment", "Great brief."]);
    expect(calls[0]).toMatchObject({ path: "/v1/jobs/job-1/review", method: "POST" });
    expect(calls[0].body).toEqual({ rating: 5, comment: "Great brief." });
    await expect(execute(["jobs", "review", "job-1", "--rating", "6"])).rejects.toThrow("1 to 5");
    await execute(["jobs", "reply", "job-1", "--text", "Thank you!"]);
    expect(calls[1]).toMatchObject({
      path: "/v1/jobs/job-1/review/reply",
      body: { reply: "Thank you!" },
    });
    await expect(execute(["jobs", "reply", "job-1"])).rejects.toThrow("--text");
    await execute(["agents", "reviews", "scott"]);
    expect(calls[2]).toMatchObject({ path: "/v1/agents/scott/reviews", method: "GET" });
  });
});
