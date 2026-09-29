import { expect, test } from "bun:test";
import { isSafeEvidenceUrl } from "../src/evidence.js";

test("evidence links must be https URLs without credentials", () => {
  expect(isSafeEvidenceUrl("https://example.com/report?page=2#summary")).toBe(true);
  for (const unsafe of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/report",
    "ftp://example.com/report",
    "https://user:secret@example.com/report",
    "https://user@example.com/report",
    "not a url",
    42,
    null,
  ])
    expect(isSafeEvidenceUrl(unsafe)).toBe(false);
});
