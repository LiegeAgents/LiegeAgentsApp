import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";

type Json = Record<string, unknown>;
const anna = { id: "agent-anna", name: "Anna by LiegeAgents", slug: "anna", sla_minutes: 60 };
const quote = {
  agentId: "agent-anna",
  agentName: "Anna by LiegeAgents",
  serviceName: "Research brief",
  slaMinutes: 60,
  deliveryBy: "2026-10-12T11:00:00Z",
  listedPriceUsd: 5,
  asset: "usdg",
  suggestedBudget: 5,
  notes: [] as string[],
};

describe("quotes in the chat", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; body?: Json }> = [];
  let output: string[] = [];

  beforeEach(() => {
    calls = [];
    output = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      calls.push({ path, body });
      let data: unknown = { id: "intent-1" };
      if (path === "/v1/super-agents/dashboard") data = { agents: [anna], jobs: [] };
      if (path === "/v1/super-agents/intents/parse") {
        const budget = /(\d+) usdg/i.exec(String(body?.text))?.[1];
        data = {
          agentName: "Anna",
          request: "Market scan",
          settlementAsset: "usdg",
          budgetAmount: budget ? Number(budget) : null,
          budgetUsdg: budget ? Number(budget) : null,
          deadlineAt: null,
          quote: {
            ...quote,
            notes: budget && Number(budget) < 5 ? ["Below Anna's listed price of 5 USD."] : [],
          },
        };
      }
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

  const chat = async () => {
    const session = new ChatSession((line) => output.push(line));
    await session.start();
    return session;
  };

  test("a request without a budget shows the quote and offers the listed price", async () => {
    const session = await chat();
    await session.handle("Hire Anna for a market scan");
    const text = output.join("\n");
    expect(text).toContain("Quote");
    expect(text).toContain("Service   Research brief");
    expect(text).toContain("5 USDG (suggested: the agent's listed price)");
    expect(text).toContain("Delivery  by");
    expect(text).toContain("Use the suggested 5 USDG");
    await session.handle("y");
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/intents",
      body: { text: "Hire Anna for a market scan", source: "cli", budgetAmount: 5 },
    });
  });

  test("replying with a budget refines the draft instead of using the suggestion", async () => {
    const session = await chat();
    await session.handle("Hire Anna for a market scan");
    await session.handle("budget 3 USDG");
    expect(output.join("\n")).toContain("Below Anna's listed price of 5 USD.");
    await session.handle("y");
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/intents",
      body: { text: "Hire Anna for a market scan\nbudget 3 USDG", source: "cli" },
    });
  });

  test("a stated budget is sent as written, without an override", async () => {
    const session = await chat();
    await session.handle("Hire Anna for a market scan, budget 8 USDG");
    expect(output.join("\n")).toContain("Budget    8 USDG");
    await session.handle("yes");
    expect(calls.at(-1)?.body).toEqual({
      text: "Hire Anna for a market scan, budget 8 USDG",
      source: "cli",
    });
  });
});
