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

export const agentActionDigest = (
  agentId: string,
  policyVersion: number,
  action: NormalizedAgentAction,
) => createHash("sha256").update(canonical({ agentId, policyVersion, action })).digest("hex");
