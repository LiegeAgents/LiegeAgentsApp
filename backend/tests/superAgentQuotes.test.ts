import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";

describe.skipIf(!databaseAvailable)("Super Agent quotes", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  // "Research Agent": a discoverable Super Agent whose service lists 5 USD with a 60 minute SLA.
  async function fixture(priceUsd = 5, assets = ["usdg"]) {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "research-brief",
          name: "Research brief",
          description: "A cited research brief.",
          serviceType: "skill",
          priceUsd,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, settlement_assets)
       VALUES ($1,$2,$3,true,now(),$4)`,
      [agentId, service.id, hook.id, assets],
    );
    return { client, agentId };
  }

  const parse = (user: Awaited<ReturnType<typeof signIn>>, text: string) =>
    api().post("/v1/super-agents/intents/parse").set(bearer(user)).send({ text }).expect(200);

  test("a request without a budget gets the agent's service, delivery time, and listed price", async () => {
    const { client, agentId } = await fixture();
    const before = Date.now();
    const { body } = await parse(client, "Hire Research Agent for a market scan");
    expect(body.data.budgetAmount).toBeNull();
    expect(body.data.quote).toMatchObject({
      agentId,
      agentName: "Research Agent",
      serviceName: "Research brief",
      serviceDescription: "A cited research brief.",
      slaMinutes: 60,
      listedPriceUsd: 5,
      asset: "usdg",
      requestedBudget: null,
      suggestedBudget: 5,
      budget: 5,
      budgetSource: "listed_price",
      deliveryFromRequest: false,
      notes: [],
    });
    const delivery = new Date(body.data.quote.deliveryBy).getTime();
    expect(delivery - before).toBeGreaterThanOrEqual(59 * 60_000);
    expect(delivery - before).toBeLessThanOrEqual(61 * 60_000);
  });

  test("a stated budget is kept, with a note when it is below the listed price", async () => {
    const { client } = await fixture();
    const { body } = await parse(client, "Hire Research Agent for a market scan, budget 3 USDG");
    expect(body.data.quote).toMatchObject({
      requestedBudget: 3,
      suggestedBudget: 5,
      budget: 3,
      budgetSource: "request",
    });
    expect(body.data.quote.notes[0]).toContain("Below Research Agent's listed price of 5 USD");
  });

  test("LIEGE budgets are never derived from the USD price", async () => {
    const { client } = await fixture(5, ["usdg", "liege"]);
    const { body } = await parse(client, "Hire Research Agent for a market scan, budget 40 LIEGE");
    expect(body.data.quote).toMatchObject({
      asset: "liege",
      requestedBudget: 40,
      suggestedBudget: null,
      budgetSource: "request",
    });
  });

  test("no suggestion when the listed price needs an independent evaluator", async () => {
    const { client } = await fixture(6000);
    const { body } = await parse(client, "Hire Research Agent for a market scan");
    expect(body.data.quote).toMatchObject({
      listedPriceUsd: 6000,
      suggestedBudget: null,
      budget: null,
    });
    expect(body.data.quote.notes).toEqual(["Add a budget to create the proposal."]);
  });

  test("an unknown agent has no quote", async () => {
    const { client } = await fixture();
    const { body } = await parse(client, "Hire Nobody for a market scan, budget 5 USDG");
    expect(body.data.quote).toBeNull();
  });

  test("accepting the suggested budget creates a proposal that approves into a 5 USDG job", async () => {
    const { client } = await fixture();
    const text = "Hire Research Agent for a market scan";
    const incomplete = await api()
      .post("/v1/super-agents/intents")
      .set(bearer(client))
      .send({ text })
      .expect(422);
    expect(incomplete.body.error.code).toBe("incomplete_proposal");

    const created = await api()
      .post("/v1/super-agents/intents")
      .set(bearer(client))
      .send({ text, budgetAmount: 5 })
      .expect(201);
    expect(created.body.data.parsed).toMatchObject({ budgetAmount: 5, budgetUsdg: 5 });
    expect(created.body.data.quote).toMatchObject({ budget: 5, budgetSource: "request" });
    const decided = await api()
      .post(`/v1/super-agents/intents/${created.body.data.id}/decision`)
      .set(bearer(client))
      .send({ decision: "approved" })
      .expect(200);
    const job = await db.query("SELECT budget_amount FROM jobs WHERE id = $1", [
      decided.body.data.job.id,
    ]);
    expect(Number(job.rows[0].budget_amount)).toBe(5);
    await api()
      .post("/v1/super-agents/intents")
      .set(bearer(client))
      .send({ text, budgetAmount: -1 })
      .expect(400);
  });
});
