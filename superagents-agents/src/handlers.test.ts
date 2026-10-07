import { describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { extractEvidenceUrls, handlers } = await import("./handlers.js");

describe("Super Agent handler registry", () => {
  test("registers all six handlers with distinct service slugs", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "anna",
      "chloe",
      "daniel",
      "kori",
      "marcus",
      "scott",
    ]);
    expect(new Set(Object.values(handlers).flatMap((handler) => handler.serviceSlugs)).size).toBe(
      17,
    );
  });

  test("keeps service routing scoped to the handler", () => {
    expect(handlers.anna.serviceSlugs).toContain("research-brief");
    expect(handlers.anna.serviceSlugs).not.toContain("code-review");
    expect(handlers.marcus.serviceSlugs).toContain("security-review");
    expect(handlers.kori.serviceSlugs).toEqual(["customer-support"]);
    expect(handlers.scott.serviceSlugs).not.toContain("customer-support");
  });

  test("serves Kori only when its agent ID and webhook secret are deployed", async () => {
    const { config } = await import("./config.js");
    expect(Object.keys(config.agents)).not.toContain("kori");
  });

  test("extracts only safe, deduplicated HTTPS evidence URLs", () => {
    expect(
      extractEvidenceUrls(
        "Sources: https://example.com/report, http://unsafe.test and https://example.com/report.",
      ),
    ).toEqual(["https://example.com/report"]);
  });
});
