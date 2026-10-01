import { createHash } from "node:crypto";

export type NormalizedAgentAction = {
  action: string;
  amount: number | null;
  asset: string | null;
  venue: string | null;
  counterparty: string | null;
  details: Record<string, unknown>;
};

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const normalizeAgentAction = (input: {
  action: string;
  amount?: number;
  asset?: string;
  venue?: string;
  counterparty?: string;
  details?: Record<string, unknown>;
}): NormalizedAgentAction => ({
  action: input.action,
  amount: input.amount ?? null,
  asset: input.asset?.toLowerCase() ?? null,
  venue: input.venue?.toLowerCase() ?? null,
  counterparty: input.counterparty?.toLowerCase() ?? null,
  details: input.details ?? {},
});

export type OwnerRules = {
  require_human_above: string | number | null;
  active_hours_start: number | null;
  active_hours_end: number | null;
  active_days: number[];
  active_timezone: string;
};

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local hour (0-23) and weekday (0 = Sunday) of `at` in an IANA time zone. */
export function localClock(timeZone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    day: weekdays.indexOf(parts.find((part) => part.type === "weekday")?.value ?? ""),
  };
}

export const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Owner rules on top of the base policy. Outside active hours is a hard denial; an amount above
 * the human-approval threshold only routes the action to the owner.
 */
export function ownerRuleReasons(rules: OwnerRules, amount: number | null, at = new Date()) {
  const denied: string[] = [];
  const review: string[] = [];
  const { hour, day } = localClock(rules.active_timezone, at);
  if (rules.active_days.length && !rules.active_days.includes(day))
    denied.push("outside_active_hours");
  else if (rules.active_hours_start != null && rules.active_hours_end != null) {
    const start = rules.active_hours_start;
    const end = rules.active_hours_end;
    const inside = start < end ? hour >= start && hour < end : hour >= start || hour < end;
    if (!inside) denied.push("outside_active_hours");
  }
  if (
    amount != null &&
    rules.require_human_above != null &&
    amount > Number(rules.require_human_above)
  )
    review.push("human_approval_required");
  return { denied, review };
}

export const agentActionDigest = (
  agentId: string,
  policyVersion: number,
  action: NormalizedAgentAction,
) => createHash("sha256").update(canonical({ agentId, policyVersion, action })).digest("hex");
