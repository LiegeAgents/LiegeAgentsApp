import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";
import { execute, squadSteps } from "../src/index.js";

type Json = Record<string, unknown>;

const agents = [
  { id: "agent-anna", name: "Anna by LiegeAgents" },
  { id: "agent-daniel", name: "Daniel by LiegeAgents" },
];

describe("squads from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let output: string[] = [];

  beforeEach(() => {
    calls = [];
    output = [];
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
      let data: unknown = { id: "squad-1", status: "running" };
      if (path === "/v1/super-agents/dashboard") data = { agents, jobs: [] };
      if (path === "/v1/super-agents/squads" && method === "GET")
        data = [
          {
            id: "8a6c2f0e-squad",
            name: "Launch my app",
            status: "running",
            steps: [
              { agent_name: "Anna", job_status: "submitted" },
              { agent_name: "Daniel", job_status: "funded" },
              { agent_name: "Scott", job_status: null },
            ],
          },
        ];
      return Response.json({ data }, { status: method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("steps are written as agent:budget:task and agents are matched by name", () => {
    expect(squadSteps("Anna:2:Research: the market; daniel:3:Plan it", agents)).toEqual([
      { agentId: "agent-anna", task: "Research: the market", budgetAmount: 2 },
      { agentId: "agent-daniel", task: "Plan it", budgetAmount: 3 },
    ]);
    expect(() => squadSteps("Nobody:2:Research", agents)).toThrow(
      'No Super Agent matches "Nobody"',
    );
    expect(() => squadSteps("Anna:free:Research", agents)).toThrow("<agent>:<budget>:<task>");
  });

  test("create posts the squad; list, get, and cancel use its routes", async () => {
    await execute([
      "superagents",
      "squads",
      "create",
      "--request",
      "Launch plan for Notely",
      "--steps",
      "Anna:2:Research the market; Daniel:3:Plan the launch",
      "--auto-fund",
    ]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/squads",
      method: "POST",
      body: {
        source: "cli",
        request: "Launch plan for Notely",
        settlementAsset: "usdg",
        autoFund: true,
        steps: [
          { agentId: "agent-anna", task: "Research the market", budgetAmount: 2 },
          { agentId: "agent-daniel", task: "Plan the launch", budgetAmount: 3 },
        ],
      },
    });
    await expect(execute(["superagents", "squads", "create", "--request", "x"])).rejects.toThrow(
      "--steps",
    );
    await execute(["superagents", "squads", "cancel", "squad-1"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/super-agents/squads/squad-1/cancel",
      method: "POST",
    });
    await execute(["superagents", "squads", "get", "squad-1"]);
    expect(calls.at(-1)?.path).toBe("/v1/super-agents/squads/squad-1");
  });

  test("/squads in the chat shows each crew's pipeline", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.handle("/squads");
    expect(output.join("\n")).toContain("Launch my app");
    expect(output.join("\n")).toContain("Anna (delivered) → Daniel (working) → Scott (queued)");
  });
});
