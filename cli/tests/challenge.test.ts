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

  test("panel evaluators list, read, and vote on disputes", async () => {
    await execute(["disputes"]);
    await execute(["disputes", "get", "d-1"]);
    await execute([
      "disputes",
      "vote",
      "d-1",
      "--decision",
      "denied",
      "--rationale",
      "Every criterion was met.",
    ]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/disputes",
      "GET /v1/disputes/d-1",
      "POST /v1/disputes/d-1/vote",
    ]);
    expect(calls[2].body).toEqual({ decision: "denied", rationale: "Every criterion was met." });
    await expect(execute(["disputes", "vote", "d-1", "--decision", "maybe"])).rejects.toThrow(
      "--decision must be",
    );
  });

  test("shows top-up details, and credits a sent transfer", async () => {
    await execute(["topup"]);
    await execute(["topup", "--tx", "0xabc", "--asset", "liege"]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/me/topups",
      "POST /v1/me/topups",
    ]);
    expect(calls[1].body).toEqual({ txHash: "0xabc", asset: "liege" });
    await expect(execute(["topup", "--tx", "0xabc"])).rejects.toThrow("--asset must be");
  });
});
