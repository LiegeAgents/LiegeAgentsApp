import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { createWebhookSubscription, replayWebhookEvents } from "../src/webhooks.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!databaseAvailable)("agents bid for a job", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function superAgent(owner: User, name: string, eventTypes = ["job.funded"]) {
    const agentId = await createAgent(owner);
    await db.query("UPDATE agents SET name=$2 WHERE id=$1", [agentId, name]);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: `svc-${crypto.randomUUID().slice(0, 8)}`,
          name: `${name} service`,
          description: `${name} delivers focused, well-organized work.`,
          serviceType: "skill",
          priceUsd: 5,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(
      owner.userId,
      agentId,
      "https://8.8.8.8/hook",
      eventTypes,
    );
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,now())`,
      [agentId, service.id, hook.id],
    );
    return { agentId, hookId: hook.id as string };
  }

  async function market() {
    const [owner, rival, client, stranger] = await Promise.all([
      signIn(),
      signIn(),
      signIn(),
      signIn(),
    ]);
    const anna = await superAgent(owner, "Anna", ["job.funded", "auction.bid_requested"]);
    const marcus = await superAgent(owner, "Marcus");
    const outside = await superAgent(rival, "Outside Agent");
    return { owner, rival, client, stranger, anna, marcus, outside };
  }

  const ask = (user: User, body: object) =>
    api().post("/v1/super-agents/auctions").set(bearer(user)).send(body);
  const bidsOf = async (auctionId: string) =>
    (
      await db.query("SELECT b.id, b.agent_id FROM superagent_bids b WHERE b.auction_id=$1", [
        auctionId,
      ])
    ).rows as Array<{ id: string; agent_id: string }>;
  const answer = (user: User, bidId: string, body: object) =>
    api().post(`/v1/super-agents/bids/${bidId}`).set(bearer(user)).send(body);

  test("agents compete, the client hires the best bid, and it becomes a funded job", async () => {
    const { owner, rival, client, anna, marcus, outside } = await market();
    await credit(client.userId, 100);
    const created = await ask(client, {
      request: "A competitor scan for my note-taking app",
      maxBudget: 8,
      biddingMinutes: 5,
    }).expect(201);
    const auction = created.body.data;
    expect(auction).toMatchObject({ phase: "bidding", maxBudget: 8, settlementAsset: "usdg" });
    expect(auction.bids).toHaveLength(3);
    const bids = await bidsOf(auction.id);
    const bidFor = (agentId: string) => bids.find((bid) => bid.agent_id === agentId)!.id;

    // The invitation reaches each agent's webhooks without the request in it.
    const events = await replayWebhookEvents(db, anna.agentId, 0n);
    expect(events.map((event) => event.eventType)).toEqual(["auction.bid_requested"]);
    expect(events[0].payload).toMatchObject({
      bidId: bidFor(anna.agentId),
      data: { auctionId: auction.id },
    });
    expect(JSON.stringify(events[0].payload)).not.toContain("competitor");
    const delivery = await db.query(
      "SELECT count(*)::int AS count FROM webhook_deliveries WHERE subscription_id=$1",
      [anna.hookId],
    );
    expect(delivery.rows[0].count).toBe(1);

    const invitation = await api()
      .get(`/v1/super-agents/bids/${bidFor(anna.agentId)}`)
      .set(bearer(owner))
      .expect(200);
    expect(invitation.body.data).toMatchObject({
      request: "A competitor scan for my note-taking app",
      open: true,
      maxBudget: 8,
      listedPriceUsd: 5,
      slaMinutes: 60,
    });

    await answer(owner, bidFor(anna.agentId), {
      price: 6,
      deliveryMinutes: 45,
      approach: "Five competitors, pricing table, cited sources.",
    }).expect(201);
    await answer(owner, bidFor(marcus.agentId), { decline: true, reason: "Not code." }).expect(201);
    expect(
      (
        await answer(rival, bidFor(outside.agentId), {
          price: 9,
          deliveryMinutes: 30,
          approach: "x",
        }).expect(422)
      ).body.error.code,
    ).toBe("over_budget");
    await answer(rival, bidFor(outside.agentId), {
      price: 4,
      deliveryMinutes: 120,
      approach: "Three competitors.",
    }).expect(201);
    expect(
      (await answer(owner, bidFor(anna.agentId), { decline: true }).expect(409)).body.error.code,
    ).toBe("bid_already_answered");

    const view = (
      await api().get(`/v1/super-agents/auctions/${auction.id}`).set(bearer(client)).expect(200)
    ).body.data;
    // Cheapest submitted bid first; declines last.
    expect(
      view.bids.map((bid: { agentName: string; status: string }) => [bid.agentName, bid.status]),
    ).toEqual([
      ["Outside Agent", "submitted"],
      ["Anna", "submitted"],
      ["Marcus", "declined"],
    ]);
    expect(view.bids[1]).toMatchObject({
      price: 6,
      deliveryMinutes: 45,
      approach: "Five competitors, pricing table, cited sources.",
    });

    const before = Date.now();
    const awarded = await api()
      .post(`/v1/super-agents/auctions/${auction.id}/award`)
      .set(bearer(client))
      .send({ bidId: bidFor(anna.agentId), fund: true })
      .expect(200);
    expect(awarded.body.data.auction).toMatchObject({ status: "awarded", phase: "awarded" });
    expect(
      awarded.body.data.auction.bids.map((bid: { agentName: string; status: string }) => [
        bid.agentName,
        bid.status,
      ]),
    ).toEqual([
      ["Anna", "won"],
      ["Outside Agent", "lost"],
      ["Marcus", "declined"],
    ]);
    const jobId = awarded.body.data.job.id;
    const job = await db.query(
      "SELECT status, budget_amount, deadline_at, strategy_policy, title FROM jobs WHERE id=$1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({ status: "funded" });
    expect(Number(job.rows[0].budget_amount)).toBe(6);
    expect(job.rows[0].title).toBe("Anna: A competitor scan for my note-taking app");
    expect(job.rows[0].strategy_policy).toMatchObject({ auctionId: auction.id });
    const deadline = new Date(job.rows[0].deadline_at).getTime();
    expect(deadline - before).toBeGreaterThanOrEqual(44 * 60_000);
    expect(deadline - before).toBeLessThanOrEqual(46 * 60_000);
    expect(await availableBalance(client.userId)).toBe(94);
    const brief = await api().get(`/v1/jobs/${jobId}/payload/brief`).set(bearer(owner)).expect(200);
    expect(brief.body.data.content).toContain("Deliver what you proposed:\nFive competitors");

    await api()
      .post(`/v1/super-agents/auctions/${auction.id}/award`)
      .set(bearer(client))
      .send({ bidId: bidFor(outside.agentId) })
      .expect(409);
  });

  test("only the invited agent's owner or scoped runtime sees and answers its bid", async () => {
    const { owner, rival, client, stranger, anna, outside } = await market();
    const auction = (await ask(client, { request: "Secret plan" }).expect(201)).body.data;
    const bids = await bidsOf(auction.id);
    const annaBid = bids.find((bid) => bid.agent_id === anna.agentId)!.id;
    const outsideBid = bids.find((bid) => bid.agent_id === outside.agentId)!.id;
    await api().get(`/v1/super-agents/bids/${annaBid}`).set(bearer(rival)).expect(404);
    await api().get(`/v1/super-agents/bids/${annaBid}`).set(bearer(client)).expect(404);
    await api().get(`/v1/super-agents/auctions/${auction.id}`).set(bearer(stranger)).expect(404);

    const runtime = (
      await api().post("/v1/super-agents/runtime-token").set(bearer(owner)).expect(201)
    ).body.data.token;
    const asRuntime = { Authorization: `Bearer ${runtime}`, "x-liege-runtime-token": "1" };
    await api().get(`/v1/super-agents/bids/${annaBid}`).set(asRuntime).expect(200);
    await api().get(`/v1/super-agents/bids/${outsideBid}`).set(asRuntime).expect(404);
    await api()
      .post(`/v1/super-agents/bids/${annaBid}`)
      .set(asRuntime)
      .send({ price: 5, deliveryMinutes: 60, approach: "Plan it." })
      .expect(201);
    // A runtime token cannot ask for bids or hire.
    await api().post("/v1/super-agents/auctions").set(asRuntime).send({ request: "x" }).expect(403);
  });

  test("bids close on time, and the client cannot invite their own agents", async () => {
    const { owner, client, anna } = await market();
    const auction = (await ask(client, { request: "Quick scan", biddingMinutes: 1 }).expect(201))
      .body.data;
    const annaBid = (await bidsOf(auction.id)).find((bid) => bid.agent_id === anna.agentId)!.id;
    await db.query(
      "UPDATE superagent_auctions SET closes_at = now() - interval '1 second' WHERE id=$1",
      [auction.id],
    );
    expect(
      (
        await answer(owner, annaBid, { price: 5, deliveryMinutes: 60, approach: "Late" }).expect(
          409,
        )
      ).body.error.code,
    ).toBe("bidding_closed");
    const view = (
      await api().get(`/v1/super-agents/auctions/${auction.id}`).set(bearer(client)).expect(200)
    ).body.data;
    expect(view.phase).toBe("choosing");
    await api()
      .post(`/v1/super-agents/auctions/${auction.id}/award`)
      .set(bearer(client))
      .send({ bidId: annaBid })
      .expect(404);

    // The owner's own agents are never invited; only the rival's agent is.
    const own = (await ask(owner, { request: "Hire someone" }).expect(201)).body.data;
    expect(own.bids.map((bid: { agentName: string }) => bid.agentName)).toEqual(["Outside Agent"]);
    await api().post(`/v1/super-agents/auctions/${own.id}/cancel`).set(bearer(owner)).expect(200);
    await api().post(`/v1/super-agents/auctions/${own.id}/cancel`).set(bearer(owner)).expect(409);
    await ask(client, { request: "x", settlementAsset: "liege" }).expect(422);
  });
});
