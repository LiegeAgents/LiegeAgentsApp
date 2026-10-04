import { describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_SESSION_TOKEN = "session-token";
process.env.GROQ_API_KEY = "groq-key";

const { handlers } = await import("./handlers.js");

describe("Super Agent handler registry", () => {
  test("registers all five handlers with distinct service slugs", () => {
    expect(Object.keys(handlers).sort()).toEqual(["anna", "chloe", "daniel", "marcus", "scott"]);
    expect(new Set(Object.values(handlers).flatMap((handler) => handler.serviceSlugs)).size).toBe(16);
  });

  test("keeps service routing scoped to the handler", () => {
    expect(handlers.anna.serviceSlugs).toContain("research-brief");
    expect(handlers.anna.serviceSlugs).not.toContain("code-review");
    expect(handlers.marcus.serviceSlugs).toContain("security-review");
  });
});
