import { describe, expect, test } from "bun:test";
import {
  agentAcceptsSettlementAsset,
  agentForDisplay,
  compareTrackRecord,
  marketplaceAgentMatches,
} from "../src/liege-app/api.js";

describe("agent service reference prices", () => {
  test("uses the lowest active service price without changing the job budget field", () => {
    const agent = agentForDisplay({
      id: "agent-1",
      slug: "image-to-video",
      name: "Image to Video",
      category: "Automation",
      services: [
        { id: "service-1", price_usd: "4.990000" },
        { id: "service-2", price_usd: "8.500000" },
      ],
    });

    expect(agent.servicePriceUsd).toBe(4.99);
    expect(agent.price).toBe(0);
    expect(agent.services).toHaveLength(2);
  });

  test("does not invent a service price when no service is listed", () => {
    expect(
      agentForDisplay({
        id: "agent-2",
        slug: "no-service",
        name: "No Service",
        category: "Research",
      }).servicePriceUsd,
    ).toBeNull();
  });
});

describe("agent settlement asset discovery", () => {
  const agent = {
    services: [{ settlement_assets: ["usdg"] }, { settlement_assets: ["liege"] }],
  };

  test("matches assets accepted by any listed service, case-insensitively", () => {
    expect(agentAcceptsSettlementAsset(agent, "USDG")).toBe(true);
    expect(agentAcceptsSettlementAsset(agent, "liege")).toBe(true);
  });

  test("does not infer service support from missing service asset data", () => {
    expect(agentAcceptsSettlementAsset({ services: [{ settlement_assets: [] }] }, "usdg")).toBe(
      false,
    );
    expect(agentAcceptsSettlementAsset({ services: [] }, "liege")).toBe(false);
  });

  test("applies category, token, saved, and search filters together", () => {
    const research = {
      id: "research-1",
      name: "Anna",
      category: "Research",
      description: "Protocol analysis",
      tags: ["marketplaces"],
      services: [{ settlement_assets: ["usdg"] }],
    };
    const development = {
      id: "dev-1",
      name: "Marcus",
      category: "Development",
      description: "Smart contracts",
      tags: [],
      services: [{ settlement_assets: ["liege"] }],
    };

    expect(
      marketplaceAgentMatches(research, {
        category: "Research",
        settlementAsset: "usdg",
        savedOnly: true,
        saved: ["research-1"],
        query: "protocol",
      }),
    ).toBe(true);
    expect(
      marketplaceAgentMatches(development, {
        category: "Development",
        settlementAsset: "usdg",
        savedOnly: true,
        saved: ["dev-1"],
        query: "contracts",
      }),
    ).toBe(false);
  });
});

describe("verified agents and track records", () => {
  const agent = (id, name, verified, reputation) =>
    agentForDisplay({ id, slug: id, name, category: "Research", verified, reputation });
  const scored = agent("scored", "Scored", true, { status: "scored", score: 81, outcomes: 9 });
  const busy = agent("busy", "Busy", false, { status: "not_scored", score: null, outcomes: 4 });
  const fresh = agent("fresh", "Fresh", true, { status: "not_scored", score: null, outcomes: 0 });
  const unknown = agent("unknown", "Unknown", false, undefined);

  test("carries recorded outcomes and the badge from the API", () => {
    expect(scored).toMatchObject({ score: 81, outcomes: 9, verified: true });
    expect(unknown).toMatchObject({ score: null, outcomes: 0, verified: false });
  });

  test("the verified filter keeps only verified Super Agents", () => {
    const shown = [scored, busy, fresh, unknown].filter((item) =>
      marketplaceAgentMatches(item, { verifiedOnly: true }),
    );
    expect(shown.map((item) => item.id)).toEqual(["scored", "fresh"]);
    expect(marketplaceAgentMatches(busy, {})).toBe(true);
  });

  test("sorts by score, then recorded outcomes, then the badge", () => {
    expect([unknown, fresh, busy, scored].sort(compareTrackRecord).map((item) => item.id)).toEqual([
      "scored",
      "busy",
      "fresh",
      "unknown",
    ]);
  });
});
