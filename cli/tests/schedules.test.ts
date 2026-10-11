import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession, parseRepeat } from "../src/chat.js";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;
const anna = { id: "agent-anna", name: "Anna by LiegeAgents", slug: "anna", sla_minutes: 30 };

describe("recurring Super Agent jobs from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let schedules: Json[] = [];

  beforeEach(() => {
    calls = [];
    schedules = [
      { id: "aaaa1111-0000-0000-0000-000000000000", status: "active" },
      { id: "bbbb2222-0000-0000-0000-000000000000", status: "paused" },
    ];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      calls.push({ path, method, body });
      let data: unknown = { id: "aaaa1111-0000-0000-0000-000000000000", status: "paused" };
      if (path === "/v1/super-agents/dashboard") data = { agents: [anna], jobs: [] };
      if (path === "/v1/super-agents/intents/parse")
        data = {
          agentName: "Anna",
          request: "Weekly competitor brief",
          settlementAsset: "usdg",
          budgetAmount: 5,
          budgetUsdg: 5,
          deadlineAt: null,
        };
      if (path === "/v1/super-agents/schedules" && method === "GET") data = schedules;
      if (path === "/v1/super-agents/schedules" && method === "POST")
        data = { id: "cccc3333-0000-0000-0000-000000000000", status: "active" };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("parses cadence, total cap, and auto-funding", () => {
    expect(parseRepeat("/repeat weekly 20 auto", 5)).toEqual({
      cadence: "weekly",
      spendCap: 20,
      autoFund: true,
    });
    expect(parseRepeat("/repeat monthly", 5)).toEqual({
      cadence: "monthly",
      spendCap: 20,
      autoFund: false,
    });
    expect(parseRepeat("/repeat sometimes", 5)).toBeNull();
  });

  test("headless commands map to the schedule API", async () => {
    await execute([
      "superagents",
      "schedules",
      "create",
      "--agent-id",
      "agent-anna",
      "--request",
      "Weekly brief",
      "--budget",
      "5",
      "--cadence",
      "weekly",
      "--cap",
      "20",
      "--auto-fund",
    ]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/schedules",
      method: "POST",
      body: {
        source: "cli",
        agentId: "agent-anna",
        request: "Weekly brief",
        settlementAsset: "usdg",
        budgetAmount: 5,
        cadence: "weekly",
        spendCap: 20,
        autoFund: true,
      },
    });
    await execute(["superagents", "schedules", "pause", "s-1"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/schedules/s-1/pause",
      method: "POST",
    });
    await execute(["superagents", "schedules", "cancel", "s-1"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/schedules/s-1",
      method: "DELETE",
    });
    await expect(execute(["superagents", "schedules", "create", "--budget", "5"])).rejects.toThrow(
      "--agent-id",
    );
  });

  test("a complete chat draft becomes a recurring job with /repeat", async () => {
    const output: string[] = [];
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    await chat.handle("Hire Anna for a weekly competitor brief, budget 5 USDG");
    await chat.handle("/repeat weekly 20 auto");
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/schedules",
      method: "POST",
      body: {
        agentId: "agent-anna",
        request: "Weekly competitor brief",
        settlementAsset: "usdg",
        budgetAmount: 5,
        cadence: "weekly",
        spendCap: 20,
        autoFund: true,
        source: "cli",
      },
    });
    expect(output.join("\n")).toContain("Recurring job cccc3333 created");
    // No one-off proposal was sent.
    expect(calls.some((call) => call.path === "/v1/super-agents/intents")).toBe(false);
  });

  test("/repeat refuses a cap below one run and keeps the draft", async () => {
    const output: string[] = [];
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    await chat.handle("Hire Anna for a weekly competitor brief, budget 5 USDG");
    await chat.handle("/repeat weekly 3");
    expect(output.at(-1)).toContain("must cover at least one run");
    expect(chat.awaitingConfirmation).not.toBeNull();
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/schedules"))).toBe(
      false,
    );
  });

  test("/schedule acts on a unique id prefix", async () => {
    const output: string[] = [];
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    await chat.handle("/schedule pause aaaa");
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/schedules/aaaa1111-0000-0000-0000-000000000000/pause",
      method: "POST",
    });
    await chat.handle("/schedule cancel zzzz");
    expect(output.at(-1)).toContain("No recurring job with that id");
  });
});
