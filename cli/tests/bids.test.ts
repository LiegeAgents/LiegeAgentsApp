import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("bids from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let polls = 0;

  const bid = (id: string, agentName: string, extra: Json = {}) => ({
    id,
    agentName,
    status: "invited",
    price: null,
    deliveryMinutes: null,
    approach: null,
    ...extra,
  });
  const auction = (bids: Json[], phase = "bidding") => ({
    id: "auction-1",
    settlementAsset: "usdg",
    phase,
    bids,
  });

  beforeEach(() => {
    calls = [];
    polls = 0;
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let data: unknown = { id: "auction-1" };
      if (path === "/v1/super-agents/auctions" && method === "POST")
        data = auction([bid("bid-anna-1234", "Anna"), bid("bid-marcus", "Marcus")]);
      if (path === "/v1/super-agents/auctions/auction-1") {
        polls++;
        data =
          polls === 1
            ? auction([
                bid("bid-anna-1234", "Anna", {
                  status: "submitted",
                  price: 6,
                  deliveryMinutes: 45,
                  approach: "Five competitors, cited.",
                }),
                bid("bid-marcus", "Marcus"),
              ])
            : auction([
                bid("bid-anna-1234", "Anna", {
                  status: "submitted",
                  price: 6,
                  deliveryMinutes: 45,
                  approach: "Five competitors, cited.",
                }),
                bid("bid-marcus", "Marcus", { status: "declined" }),
              ]);
      }
      return Response.json({ data }, { status: method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("headless create, award, and cancel", async () => {
    await execute([
      "superagents",
      "auctions",
      "create",
      "--request",
      "Competitor scan",
      "--max-budget",
      "8",
      "--minutes",
      "5",
    ]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/auctions",
      method: "POST",
      body: {
        request: "Competitor scan",
        settlementAsset: "usdg",
        maxBudget: 8,
        biddingMinutes: 5,
        source: "cli",
      },
    });
    await execute(["superagents", "auctions", "award", "auction-1", "bid-anna", "--fund"]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/super-agents/auctions/auction-1/award",
      method: "POST",
      body: { bidId: "bid-anna", fund: true },
    });
    await expect(execute(["superagents", "auctions", "award", "auction-1"])).rejects.toThrow(
      "bid to hire",
    );
    await execute(["superagents", "auctions", "cancel", "auction-1"]);
    expect(calls.at(-1)?.path).toBe("/v1/super-agents/auctions/auction-1/cancel");
  });

  test("/bid streams each agent's answer until every agent has answered", async () => {
    const output: string[] = [];
    const chat = new ChatSession((line) => output.push(line));
    chat.sleep = async () => {};
    await chat.handle("/bid A competitor scan for Notely");
    expect(calls[0].body).toMatchObject({
      request: "A competitor scan for Notely",
      biddingMinutes: 2,
    });
    const text = output.join("\n");
    expect(text).toContain("Asked 2 agents to bid");
    expect(text).toContain("Anna  6 USDG · 45 min");
    expect(text).toContain("Five competitors, cited.");
    expect(text).toContain("Marcus passed.");
    expect(text.match(/Anna {2}6 USDG/g)).toHaveLength(1);
    expect(text).toContain("1 bid in. Hire one in");
    expect(polls).toBe(2);
  });
});
