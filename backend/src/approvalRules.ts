import { z } from "zod";

/**
 * Objective checks on a delivery. They read only the delivery text and its evidence links, never
 * the network, so a check means the same thing every time it runs.
 */
export const approvalRule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("min_words"), value: z.number().int().min(1).max(100_000) }),
  z.object({ type: z.literal("max_words"), value: z.number().int().min(1).max(100_000) }),
  // Case-insensitive text the delivery must include.
  z.object({ type: z.literal("contains"), value: z.string().trim().min(1).max(200) }),
  // A Markdown heading (any level) with this title.
  z.object({ type: z.literal("heading"), value: z.string().trim().min(1).max(120) }),
  // The whole delivery is valid JSON, optionally an object with these top-level keys.
  z.object({
    type: z.literal("json"),
    keys: z.array(z.string().min(1).max(100)).max(50).default([]),
  }),
  // At least this many evidence links submitted with the delivery.
  z.object({ type: z.literal("min_links"), value: z.number().int().min(1).max(20) }),
]);
export type ApprovalRule = z.infer<typeof approvalRule>;
export const approvalRules = z.array(approvalRule).min(1).max(10);

export type RuleResult = { rule: ApprovalRule; passed: boolean; detail: string };

// Markdown markers such as "#" or "-" are not words.
const words = (text: string) =>
  text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function checkRule(rule: ApprovalRule, deliverable: string, evidence: string[]): RuleResult {
  switch (rule.type) {
    case "min_words": {
      const count = words(deliverable);
      return {
        rule,
        passed: count >= rule.value,
        detail: `${plural(count, "word")}; needs at least ${rule.value}.`,
      };
    }
    case "max_words": {
      const count = words(deliverable);
      return {
        rule,
        passed: count <= rule.value,
        detail: `${plural(count, "word")}; allows at most ${rule.value}.`,
      };
    }
    case "contains": {
      const passed = deliverable.toLowerCase().includes(rule.value.toLowerCase());
      return {
        rule,
        passed,
        detail: passed ? `Includes "${rule.value}".` : `Does not include "${rule.value}".`,
      };
    }
    case "heading": {
      const passed = new RegExp(`^#{1,6}\\s+${escape(rule.value)}\\s*#*\\s*$`, "im").test(
        deliverable,
      );
      return {
        rule,
        passed,
        detail: passed ? `Has a "${rule.value}" heading.` : `No "${rule.value}" heading.`,
      };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(deliverable);
      } catch {
        return { rule, passed: false, detail: "Not valid JSON." };
      }
      if (!rule.keys.length) return { rule, passed: true, detail: "Valid JSON." };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return {
          rule,
          passed: false,
          detail: "Valid JSON, but not an object with the required keys.",
        };
      const missing = rule.keys.filter((key) => !(key in (parsed as Record<string, unknown>)));
      return {
        rule,
        passed: !missing.length,
        detail: missing.length
          ? `Missing keys: ${missing.join(", ")}.`
          : "Valid JSON with every required key.",
      };
    }
    case "min_links":
      return {
        rule,
        passed: evidence.length >= rule.value,
        detail: `${plural(evidence.length, "evidence link")}; needs at least ${rule.value}.`,
      };
  }
}

export function checkRules(rules: ApprovalRule[], deliverable: string, evidence: string[]) {
  const results = rules.map((rule) => checkRule(rule, deliverable, evidence));
  return { passed: results.every((result) => result.passed), results };
}
