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
  type User,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { answerCounter } from "../src/superAgentCounters.js";

describe("counter-offer rule", () => {
  test("accepts at or above the lowest price and answers lower offers with it", () => {
    expect(answerCounter(4, 4)).toEqual({ outcome: "accepted", agreed: 4 });
    expect(answerCounter(4.5, 4)).toEqual({ outcome: "accepted", agreed: 4.5 });
    expect(answerCounter(3, 4)).toEqual({ outcome: "countered", agreed: 4 });
  });
});

describe.skipIf(!databaseAvailable)("Super Agent counter-offers", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  // "Research Agent" lists 5 USD; its owner accepts as low as `minPriceUsd` when countered.
  async function fixture(minPriceUsd?: number, assets = ["usdg"], priceUsd = 5) {
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
          ...(minPriceUsd ? { minPriceUsd } : {}),
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
    return { owner, client, agentId, serviceId: service.id as string };
  }

  const propose = async (
    client: User,
    budgetAmount: number,
    text = "Hire Research Agent for a market scan",
  ) =>
    (
      await api()
        .post("/v1/super-agents/intents")
        .set(bearer(client))
        .send({ text, budgetAmount })
        .expect(201)
    ).body.data.id as string;
  const counter = (client: User, id: string, budgetAmount: number) =>
    api().post(`/v1/super-agents/intents/${id}/counter`).set(bearer(client)).send({ budgetAmount });

  test("the agent names its lowest price, accepts an offer at or above it, and approval opens the job at the agreed budget", async () => {
    const { client } = await fixture(4);
    const id = await propose(client, 5);

    const first = (await counter(client, id, 3).expect(200)).body.data;
    expect(first.round).toMatchObject({ offer: 3, outcome: "countered", agreed: 4 });
    expect(first.parsed).toMatchObject({ budgetAmount: 4, budgetUsdg: 4 });
    expect(first.message).toBe(
      "Research Agent can do it for 4 USDG. Approve at that price, or counter once more.",
    );

    const second = (await counter(client, id, 4.5).expect(200)).body.data;
    expect(second.round).toMatchObject({ offer: 4.5, outcome: "accepted", agreed: 4.5 });
    expect(second.negotiation).toHaveLength(2);
    expect((await counter(client, id, 4).expect(409)).body.error.code).toBe("counter_limit");

    const listed = (await api().get("/v1/super-agents/intents").set(bearer(client)).expect(200))
      .body.data;
    expect(listed[0].negotiation).toHaveLength(2);

    const decided = await api()
      .post(`/v1/super-agents/intents/${id}/decision`)
      .set(bearer(client))
      .send({ decision: "approved" })
      .expect(200);
    const job = await db.query("SELECT budget_amount FROM jobs WHERE id = $1", [
      decided.body.data.job.id,
    ]);
    expect(Number(job.rows[0].budget_amount)).toBe(4.5);
    // A decided proposal cannot be countered.
    expect((await counter(client, id, 5).expect(409)).body.error.code).toBe("proposal_unavailable");
  });

  test("without a lowest price set, the listed price is the floor", async () => {
    const { client } = await fixture();
    const id = await propose(client, 5);
    const answer = (await counter(client, id, 4).expect(200)).body.data;
    expect(answer.round).toMatchObject({ outcome: "countered", agreed: 5 });
  });

  test("only USDG budgets are negotiable, and only by the proposal's client", async () => {
    const { client } = await fixture(4, ["usdg", "liege"]);
    const stranger = await signIn();
    const id = await propose(client, 5);
    expect((await counter(stranger, id, 4).expect(409)).body.error.code).toBe(
      "proposal_unavailable",
    );
    const liege = await propose(
      client,
      1000,
      "Hire Research Agent for a market scan, budget 1000 LIEGE",
    );
    expect((await counter(client, liege, 900).expect(422)).body.error.code).toBe(
      "counter_usdg_only",
    );
  });

  test("only the owner sets the lowest price, never above the listed price, and it stays private", async () => {
    const { owner, client, serviceId, agentId } = await fixture();
    await api()
      .patch(`/v1/services/${serviceId}/min-price`)
      .set(bearer(client))
      .send({ minPriceUsd: 3 })
      .expect(404);
    expect(
      (
        await api()
          .patch(`/v1/services/${serviceId}/min-price`)
          .set(bearer(owner))
          .send({ minPriceUsd: 6 })
          .expect(422)
      ).body.error.code,
    ).toBe("min_price_above_list");
    const set = await api()
      .patch(`/v1/services/${serviceId}/min-price`)
      .set(bearer(owner))
      .send({ minPriceUsd: 3 })
      .expect(200);
    expect(Number(set.body.data.min_price_usd)).toBe(3);
    const publicServices = JSON.stringify((await api().get("/v1/services").expect(200)).body);
    expect(publicServices).not.toContain("min_price");
    const publicAgents = JSON.stringify((await api().get("/v1/agents").expect(200)).body);
    expect(publicAgents).not.toContain("min_price");
    expect(agentId).toBeTruthy();
    await api()
      .patch(`/v1/services/${serviceId}/min-price`)
      .set(bearer(owner))
      .send({ minPriceUsd: null })
      .expect(200);
  });
});
