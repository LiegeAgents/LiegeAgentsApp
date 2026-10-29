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

describe.skipIf(!databaseAvailable)("service examples", () => {
  beforeAll(rebuildSchema);
  let owner: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    owner = await signIn();
    agentId = await createAgent(owner);
  });

  const service = (body: object = {}) =>
    api()
      .post("/v1/services")
      .set(bearer(owner))
      .send({
        agentId,
        slug: "research-brief",
        name: "Research brief",
        description: "A cited research brief.",
        serviceType: "skill",
        priceUsd: 5,
        slaMinutes: 60,
        ...body,
      });

  test("an owner publishes, changes, and clears a service's example", async () => {
    await service({ sampleRequest: "x".repeat(2001) }).expect(400);
    const created = (
      await service({
        sampleRequest: "  Research tokenized stocks on Robinhood Chain.\u0007 ",
        sampleDeliverable: "# Tokenized stocks\n- Three issuers, with sources.",
      }).expect(201)
    ).body.data;
    expect(created).toMatchObject({
      sample_request: "Research tokenized stocks on Robinhood Chain.",
      sample_deliverable: "# Tokenized stocks\n- Three issuers, with sources.",
    });
    const listed = (await api().get(`/v1/services?agentId=${agentId}`).expect(200)).body.data[0];
    expect(listed).toMatchObject({ sample_request: created.sample_request });
    const one = (await api().get(`/v1/services/${agentId}/research-brief`).expect(200)).body.data;
    expect(one.sample_deliverable).toContain("Three issuers");

    const stranger = await signIn();
    const patch = (user: User, body: object) =>
      api().patch(`/v1/services/${created.id}/example`).set(bearer(user)).send(body);
    await patch(stranger, { sampleRequest: "Mine now", sampleDeliverable: null }).expect(404);
    await patch(owner, { sampleRequest: "", sampleDeliverable: null }).expect(400);
    const changed = (
      await patch(owner, { sampleRequest: "Compare two L2s.", sampleDeliverable: null }).expect(200)
    ).body.data;
    expect(changed).toEqual({
      id: created.id,
      sample_request: "Compare two L2s.",
      sample_deliverable: null,
    });
    await patch(owner, { sampleRequest: null, sampleDeliverable: null }).expect(200);
    const cleared = (await api().get(`/v1/services/${agentId}/research-brief`).expect(200)).body
      .data;
    expect(cleared).toMatchObject({ sample_request: null, sample_deliverable: null });
  });

  test("A2A cards and the hiring catalog carry the example", async () => {
    const created = (
      await service({
        sampleRequest: "Research tokenized stocks on Robinhood Chain.",
        sampleDeliverable: "# Tokenized stocks",
      }).expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, settlement_assets)
       VALUES ($1,$2,$3,true,now(),$4)`,
      [agentId, created.id, hook.id, ["usdg"]],
    );
    const card = (await api().get("/.well-known/agent-card.json").expect(200)).body;
    expect(card.skills[0].examples).toEqual(["Research tokenized stocks on Robinhood Chain."]);
  });
});
