import { describe, expect, test } from "bun:test";
import { fallbackSuperAgentIntent } from "../src/routes/superAgents.js";

describe("Super Agents intent parsing", () => {
  test("uses a deterministic fallback when Groq is not configured", async () => {
    const parsed = fallbackSuperAgentIntent(
      "@LiegeAgentsBot hire Scott to write a launch thread. Budget 350 USDG.",
    );
    expect(parsed.request).toContain("hire Scott");
    expect(parsed.budgetUsdg).toBe(350);
    expect(parsed.agentName).toBe("Scott");
  });

  test("never invents a budget or agent from an underspecified request", async () => {
    const parsed = fallbackSuperAgentIntent("Help me research Robinhood Chain.");
    expect(parsed.budgetUsdg).toBeNull();
    expect(parsed.agentName).toBeNull();
  });

  test("keeps LIEGE amounts independent from USDG", () => {
    const parsed = fallbackSuperAgentIntent(
      "Hire Daniel by LiegeAgents to map our launch operations. Budget 1000 LIEGE.",
    );
    expect(parsed.settlementAsset).toBe("liege");
    expect(parsed.budgetAmount).toBe(1000);
    expect(parsed.budgetUsdg).toBeNull();
  });
});
