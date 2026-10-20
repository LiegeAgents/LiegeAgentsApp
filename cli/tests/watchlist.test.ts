import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession, parseWatch } from "../src/chat.js";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;
const token = "0x1111111111111111111111111111111111111111";

const watch = {
  id: "aaaa1111-0000-0000-0000-000000000000",
  watch_token: token,
  watch_chain: "base",
  chain_name: "Base",
  agent_name: "Constantine",
  settlement_asset: "usdg",
  budget_amount: "0.5",
  next_run_at: "2026-10-21T00:00:00.000Z",
  spend_cap: "15",
  committed_amount: "1.5",
  auto_fund: false,
  status: "active",
  runs: [
    {
      id: "run-3",
      outcome: "awaiting_funding",
      job_id: "job-3",
      job_status: "open",
      verdict: null,
      risk_score: null,
      baseline: null,
      changes: [],
      checked_at: null,
    },
    {
      id: "run-2",
      outcome: "funded",
      job_id: "job-2",
      job_status: "submitted",
      verdict: "high risk",
      risk_score: 72,
      baseline: false,
      changes: [
        { signal: "liquidity", label: "Liquidity", detail: "Liquidity fell by 60%." },
        { signal: "tax", label: "Sell tax", detail: "The sell tax rose to 25%." },
      ],
      checked_at: "2026-10-20T00:05:00.000Z",
    },
    {
      id: "run-1",
      outcome: "funded",
      job_id: "job-1",
      job_status: "completed",
      verdict: "low risk",
      risk_score: 12,
      baseline: true,
      changes: [],
      checked_at: "2026-10-19T00:05:00.000Z",
    },
  ],
};

describe("Constantine's watchlist from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let failWith: { status: number; code: string } | null = null;
  let output: string[] = [];

  beforeEach(() => {
    calls = [];
    output = [];
    failWith = null;
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({
        path,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      if (failWith && method === "POST")
        return Response.json(
          { error: { code: failWith.code, message: "server wording" } },
          { status: failWith.status },
        );
      let data: unknown = { ...watch, status: "cancelled" };
      if (path === "/v1/super-agents/watchlist" && method === "GET") data = [watch];
      if (path === "/v1/super-agents/watchlist" && method === "POST")
        data = { ...watch, runs: [], committed_amount: "0" };
      return Response.json({ data }, { status: method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("parses the token, an optional chain, and auto-funding", () => {
    expect(parseWatch(`/watch ${token.toUpperCase().replace("0X", "0x")} Base auto`)).toEqual({
      token,
      chain: "base",
      autoFund: true,
    });
    expect(parseWatch(`/watch ${token}`)).toEqual({ token, autoFund: false });
    expect(parseWatch("/watch 0x1234")).toBeNull();
    expect(parseWatch(`/watch ${token} solana`)).toBeNull();
  });

  test("/watch creates a daily watch and says what it costs", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.handle(`/watch ${token} base`);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/watchlist",
      method: "POST",
      body: { token, chain: "base", autoFund: false, source: "cli" },
    });
    const text = output.join("\n");
    expect(text).toContain(`Watching ${token} on Base.`);
    expect(text).toContain("re-checks it daily: 0.5 USDG per check, up to 15 USDG in total");
    expect(text).toContain("alert only when ownership, liquidity, a tax, or a honeypot flag");
    expect(text).not.toMatch(/\b(safe|guaranteed|real-time|live)\b/i);
  });

  test("/watch turns API refusals into plain answers", async () => {
    const chat = new ChatSession((line) => output.push(line));
    for (const [status, code, expected] of [
      [409, "already_watching", "already on your watchlist"],
      [404, "watch_agent_unavailable", "No rug-check agent"],
      [422, "budget_required", "no listed price"],
      [409, "schedule_limit", "/schedule cancel <id>"],
    ] as const) {
      failWith = { status, code };
      await chat.handle(`/watch ${token}`);
      expect(output.at(-1)).toContain(expected);
    }
    failWith = { status: 500, code: "internal" };
    await expect(chat.handle(`/watch ${token}`)).rejects.toThrow("server wording");
    await chat.handle("/watch not-a-token");
    expect(output.at(-1)).toContain("Usage: /watch");
  });

  test("/watchlist shows the latest verdict, the last alert, and unfunded checks", async () => {
    await new ChatSession((line) => output.push(line)).handle("/watchlist");
    const text = output.join("\n");
    expect(text).toContain("0x1111…1111 on Base, 0.5 USDG/check, 1.5/15 USDG used");
    expect(text).toContain("Latest check: high risk, risk 72/100");
    expect(text).toContain("Liquidity fell by 60%. The sell tax rose to 25%.");
    expect(text).toContain("1 check waiting for funding");
  });

  test("liege watchlist summarizes each watch; cancel uses the schedule route", async () => {
    const [summary] = (await execute(["watchlist"])) as Json[];
    expect(summary).toMatchObject({
      id: watch.id,
      token,
      chain: "Base",
      status: "active",
      nextCheckAt: "2026-10-21T00:00:00.000Z",
      awaitingFunding: 1,
      latest: { verdict: "high risk", riskScore: 72, baseline: false, jobId: "job-2" },
      lastAlert: {
        jobId: "job-2",
        changes: ["Liquidity fell by 60%.", "The sell tax rose to 25%."],
      },
    });
    await execute(["watchlist", "get", "w-1"]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/super-agents/watchlist/w-1", method: "GET" });
    await execute(["watchlist", "cancel", "w-1"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/schedules/w-1",
      method: "DELETE",
    });
    await execute(["watchlist", "pause", "w-1"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/schedules/w-1/pause",
      method: "POST",
    });
  });
});
