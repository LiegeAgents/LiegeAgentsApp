import { selfSettlementLimit } from "./capacity.js";
import { db } from "./db/index.js";
import { findEnrolledAgent } from "./superAgentEnrollment.js";

type ParsedIntent = {
  agentName: string | null;
  settlementAsset: "usdg" | "liege";
  budgetAmount: number | null;
  budgetUsdg: number | null;
  deadlineAt: string | null;
};

/**
 * What the client gets before approving: the matched agent's service, its delivery time, and a
 * budget. The suggestion is the agent's own listed price and is offered only for USDG, which
 * tracks USD; LIEGE is an independent token, so a LIEGE budget is always the client's own.
 */
export async function quoteIntent(parsed: ParsedIntent, now = new Date()) {
  const agent = await findEnrolledAgent(parsed.agentName, parsed.settlementAsset);
  if (!agent) return null;
  const service = await db.query<{ name: string }>(
    "SELECT name FROM commerce_services WHERE id = $1",
    [agent.service_id],
  );
  const asset = parsed.settlementAsset;
  const limit = selfSettlementLimit(asset);
  const price = Number(agent.price_usd);
  const listedPrice = Number.isFinite(price) && price > 0 ? price : null;
  const requested = parsed.budgetAmount ?? parsed.budgetUsdg ?? null;
  // Super Agent jobs are settled by the client, which is allowed only below the limit.
  const suggested =
    asset === "usdg" && listedPrice !== null && listedPrice < limit ? listedPrice : null;
  const requestedDeadline = parsed.deadlineAt ? new Date(parsed.deadlineAt) : null;
  const deliveryBy =
    requestedDeadline && Number.isFinite(requestedDeadline.getTime()) && requestedDeadline > now
      ? requestedDeadline
      : new Date(now.getTime() + agent.sla_minutes * 60_000);
  const notes: string[] = [];
  if (requested !== null && asset === "usdg" && listedPrice !== null && requested < listedPrice)
    notes.push(
      `Below ${agent.name}'s listed price of ${listedPrice} USD. Counter after creating the proposal: the agent accepts or names its best price.`,
    );
  if (requested !== null && requested >= limit)
    notes.push(`Budgets of ${limit} ${asset.toUpperCase()} or more need an independent evaluator.`);
  if (requested === null && suggested === null)
    notes.push(
      asset === "liege"
        ? "LIEGE budgets are set by you; LIEGE is never converted from the USD price."
        : "Add a budget to create the proposal.",
    );
  return {
    agentId: agent.id as string,
    agentName: agent.name as string,
    serviceName: service.rows[0]?.name ?? agent.service_slug,
    serviceDescription: agent.description as string,
    slaMinutes: agent.sla_minutes as number,
    deliveryBy: deliveryBy.toISOString(),
    deliveryFromRequest: deliveryBy === requestedDeadline,
    listedPriceUsd: listedPrice,
    asset,
    requestedBudget: requested,
    suggestedBudget: suggested,
    budget: requested ?? suggested,
    budgetSource: requested !== null ? "request" : suggested !== null ? "listed_price" : null,
    notes,
  };
}
