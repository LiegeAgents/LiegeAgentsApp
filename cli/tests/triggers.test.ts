import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("GitHub triggers from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];

  beforeEach(() => {
    calls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data =
        path === "/v1/super-agents/triggers" && method === "GET"
          ? [
              {
                id: "3f2a91c0-trigger",
                status: "active",
                repository: "acme/shop",
                branch: "main",
                agent_name: "Marcus",
                settlement_asset: "usdg",
                committed_amount: "5",
                spend_cap: "50",
                verified_at: null,
                runs: [{ pull_number: 7, title: "Add checkout", outcome: "funded" }],
              },
            ]
          : { id: "trigger-1" };
      return Response.json({ data }, { status: method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("create sends the repository, budget, cap, and comment choice", async () => {
    await execute([
      "superagents",
      "triggers",
      "create",
      "--agent-id",
      "agent-marcus",
      "--repo",
      "acme/shop",
      "--budget",
      "5",
      "--cap",
      "50",
      "--auto-fund",
      "--no-comment",
    ]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/triggers",
      method: "POST",
      body: {
        agentId: "agent-marcus",
        repository: "acme/shop",
        settlementAsset: "usdg",
        budgetAmount: 5,
        spendCap: 50,
        autoFund: true,
        postComment: false,
        source: "cli",
      },
    });
    await expect(execute(["superagents", "triggers", "create", "--repo", "a/b"])).rejects.toThrow(
      "--agent-id",
    );
    await execute(["superagents", "triggers", "pause", "trigger-1"]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/super-agents/triggers/trigger-1/pause" });
    await execute(["superagents", "triggers", "cancel", "trigger-1"]);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  test("/triggers lists repositories and recent reviews", async () => {
    const output: string[] = [];
    await new ChatSession((line) => output.push(line)).handle("/triggers");
    const text = output.join("\n");
    expect(text).toContain("acme/shop:main");
    expect(text).toContain("waiting for GitHub");
    expect(text).toContain("#7 Add checkout: funded");
  });
});
