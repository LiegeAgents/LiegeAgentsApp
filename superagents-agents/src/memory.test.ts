import { describe, expect, test } from "bun:test";
import { memoryNote } from "./memory.js";

describe("client memory", () => {
  test("adds preferences and past feedback as the client's own words", () => {
    const note = memoryNote({
      enabled: true,
      preferences: "Use bullet points and cite sources.",
      learned: [{ jobTitle: "Market scan", feedback: "Add a summary at the top." }],
    });
    expect(note).toContain("<client_memory>");
    expect(note).toContain("Their standing preferences: Use bullet points and cite sources.");
    expect(note).toContain('Their revision feedback on "Market scan": Add a summary at the top.');
    expect(note).toContain("this job's brief wins");
  });

  test("adds nothing when memory is off, empty, or unavailable", () => {
    expect(memoryNote(null)).toBe("");
    expect(memoryNote({ enabled: false, preferences: "x", learned: [] })).toBe("");
    expect(memoryNote({ enabled: true, preferences: null, learned: [] })).toBe("");
  });
});
