import { describe, expect, test } from "bun:test";
import { agentForDisplay } from "../src/liege-app/api.js";

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
