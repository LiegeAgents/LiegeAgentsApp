import { describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { bidBounds, prepareBid } = await import("./bidding.js");

const invitation = {
  id: "bid-1",
  auctionId: "auction-1",
  status: "invited",
  open: true,
  request: "A competitor scan for my note-taking app",
  settlementAsset: "usdg" as const,
  maxBudget: 8,
  closesAt: "2026-10-12T16:00:00Z",
  serviceSlug: "research-brief",
  listedPriceUsd: 5,
  slaMinutes: 60,
  maxPrice: 50,
};

describe("bidding", () => {
  test("bids stay near the listed price, within the client's maximum", () => {
    expect(bidBounds(invitation)).toEqual({
      low: 2.5,
      high: 8,
      suggested: 5,
      minMinutes: 30,
      maxMinutes: 180,
      sla: 60,
    });
    expect(bidBounds({ ...invitation, maxBudget: 2 })).toBeNull();
    // USD prices are never converted to LIEGE; without a maximum there is nothing to price against.
    expect(bidBounds({ ...invitation, settlementAsset: "liege", maxBudget: null })).toBeNull();
    expect(bidBounds({ ...invitation, settlementAsset: "liege", maxBudget: 40 })).toMatchObject({
      low: 0.01,
      high: 40,
    });
  });

  test("a fitting request gets a pitch, clamped to the allowed range", async () => {
    let prompt = "";
    const answer = await prepareBid("anna", invitation, async (system, user) => {
      prompt = `${system}\n${user}`;
      return { bid: true, price: 99, deliveryMinutes: 1, approach: "Five competitors, cited." };
    });
    expect(answer).toEqual({ price: 8, deliveryMinutes: 30, approach: "Five competitors, cited." });
    expect(prompt).toContain("You are Anna, a rigorous research analyst");
    expect(prompt).toContain("Price: 2.5 to 8 USDG");
  });

  test("an agent declines work outside its services or below its floor", async () => {
    expect(
      await prepareBid("marcus", invitation, async () => ({ bid: false, reason: "Not code." })),
    ).toEqual({ decline: true, reason: "Not code." });
    let called = false;
    const cheap = await prepareBid("anna", { ...invitation, maxBudget: 1 }, async () => {
      called = true;
      return {};
    });
    expect(cheap).toEqual({
      decline: true,
      reason: "The maximum budget is below what this work costs.",
    });
    expect(called).toBe(false);
  });
});
