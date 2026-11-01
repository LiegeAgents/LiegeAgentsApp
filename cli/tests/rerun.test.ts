import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("jobs rerun", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let brief: string | null = "Cover the five largest moves and link every source.";

  beforeEach(() => {
    calls = [];
    brief = "Cover the five largest moves and link every source.";
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      calls.push({ path, method, body });
      let data: unknown = { id: "job-new" };
      if (path === "/v1/jobs/job-1")
        data = {
          id: "job-1",
          agent_id: "agent-1",
          evaluator_id: null,
          kind: "standard",
          title: "Weekly market summary",
          acceptance_criteria: ["Five moves covered"],
          settlement_asset: "usdg",
          budget_amount: "12.500000000000000000",
          evaluator_fee_amount: "0",
          created_at: "2026-10-01T00:00:00Z",
          deadline_at: "2026-10-04T00:00:00Z",
          expires_at: "2026-10-11T00:00:00Z",
          strategy_policy: null,
          challenge_window_hours: 24,
          approval_rules: [{ type: "min_links", value: 5 }],
          promised_minutes: null,
        };
      if (path === "/v1/jobs/job-1/payload/brief") data = { content: brief };
      return new Response(JSON.stringify({ data }), {
        status: method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("opens a new job like the old one, with a deadline as far out", async () => {
    const before = Date.now();
    await execute(["jobs", "rerun", "job-1"]);
    const created = calls.at(-1)!;
    expect(created).toMatchObject({ path: "/v1/jobs", method: "POST" });
    expect(created.body).toMatchObject({
      agentId: "agent-1",
      kind: "standard",
      title: "Weekly market summary",
      brief: "Cover the five largest moves and link every source.",
      acceptanceCriteria: ["Five moves covered"],
      settlementAsset: "usdg",
      budgetUsdg: "12.5",
      challengeWindowHours: 24,
      approvalRules: [{ type: "min_links", value: 5 }],
    });
    expect(created.body).not.toHaveProperty("evaluatorId");
    expect(created.body).not.toHaveProperty("deliveryPromiseMinutes");
    const deadline = Date.parse(String(created.body!.deadlineAt));
    expect(Math.round((deadline - before) / 864e5)).toBe(3);
    expect(Date.parse(String(created.body!.expiresAt)) - deadline).toBe(7 * 864e5);

    await execute(["jobs", "rerun", "job-1", "--deadline-days", "10"]);
    expect(Math.round((Date.parse(String(calls.at(-1)!.body!.deadlineAt)) - before) / 864e5)).toBe(
      10,
    );
  });

  test("refuses when the brief is gone", async () => {
    brief = null;
    await expect(execute(["jobs", "rerun", "job-1"])).rejects.toThrow("no longer available");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
