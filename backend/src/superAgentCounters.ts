import type { PoolClient } from "pg";
import { selfSettlementLimit } from "./capacity.js";
import { ApiError } from "./http.js";
import { readyEnrollment } from "./superAgentEnrollment.js";

/** A client may counter twice; after that the agent's best price stands. */
export const MAX_COUNTERS = 2;

export type CounterRound = {
  at: string;
  offer: number;
  outcome: "accepted" | "countered";
  agreed: number;
};

/**
 * The agent's answer to a counter-offer, by its owner's rule: an offer at or above the lowest
 * price is accepted; a lower one is met with the lowest price. Nothing else is negotiable here.
 */
export function answerCounter(offer: number, lowest: number) {
  return offer >= lowest
    ? { outcome: "accepted" as const, agreed: offer }
    : { outcome: "countered" as const, agreed: lowest };
}

/** The lowest USD price the agent's enrolled service accepts: its floor, else its listed price. */
export async function lowestPrice(client: PoolClient, agentId: string) {
  const found = await client.query<{ price_usd: string | null; min_price_usd: string | null }>(
    `SELECT s.price_usd, s.min_price_usd FROM agents a ${readyEnrollment}
     WHERE a.id = $1 AND a.active AND e.enabled AND e.verified_at IS NOT NULL`,
    [agentId],
  );
  const row = found.rows[0];
  const listed = Number(row?.price_usd ?? 0);
  if (!row || !(listed > 0))
    throw new ApiError(
      422,
      "counter_unavailable",
      "This agent has no listed price to negotiate from.",
    );
  return row.min_price_usd ? Number(row.min_price_usd) : listed;
}

/** Applies one counter-offer to a pending proposal's parsed terms. */
export async function counterProposal(
  client: PoolClient,
  intent: { agent_id: string; negotiation: CounterRound[] },
  asset: "usdg" | "liege",
  offer: number,
) {
  if (asset !== "usdg")
    throw new ApiError(
      422,
      "counter_usdg_only",
      "Counter-offers work for USDG budgets; a LIEGE budget is always yours to set.",
    );
  if (intent.negotiation.length >= MAX_COUNTERS)
    throw new ApiError(
      409,
      "counter_limit",
      `You can counter ${MAX_COUNTERS} times; approve the agent's price or dismiss the proposal.`,
    );
  if (offer >= selfSettlementLimit(asset))
    throw new ApiError(
      422,
      "self_evaluation_limit",
      `Budgets of ${selfSettlementLimit(asset)} USDG or more need an independent evaluator.`,
    );
  const answer = answerCounter(offer, await lowestPrice(client, intent.agent_id));
  const round: CounterRound = { at: new Date().toISOString(), offer, ...answer };
  return { round, negotiation: [...intent.negotiation, round] };
}
