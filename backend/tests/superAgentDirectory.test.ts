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

describe.skipIf(!databaseAvailable)("hireable Super Agents", () => {
  let owner: User;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    owner = await signIn();
  });

  async function listed(name: string, enroll: { verified?: boolean; assets?: string[] } = {}) {
    const agentId = await createAgent(owner);
    await db.query("UPDATE agents SET name = $2 WHERE id = $1", [agentId, name]);
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
          slaMinutes: 90,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, settlement_assets)
       VALUES ($1,$2,$3,true,$4,$5)`,
      [
        agentId,
        service.id,
        hook.id,
        enroll.verified === false ? null : new Date(),
        enroll.assets ?? ["usdg", "liege"],
      ],
    );
    return agentId;
  }

  test("lists only verified, enrolled agents that take the asset, publicly", async () => {
    const anna = await listed("Anna");
    await listed("Unverified", { verified: false });
    const usdgOnly = await listed("Dollar", { assets: ["usdg"] });
    await createAgent(owner); // never enrolled

    const usdg = (await api().get("/v1/super-agents/hireable").expect(200)).body.data;
    expect(usdg.map((agent: { name: string }) => agent.name).sort()).toEqual(["Anna", "Dollar"]);
    expect(usdg.find((agent: { id: string }) => agent.id === anna)).toMatchObject({
      serviceName: "Anna service",
      priceUsd: "5",
      slaMinutes: 90,
      reputation: { outcomes: 0 },
    });
    const liege = (await api().get("/v1/super-agents/hireable?asset=liege").expect(200)).body.data;
    expect(liege.map((agent: { id: string }) => agent.id)).toEqual([anna]);
    expect(liege.map((agent: { id: string }) => agent.id)).not.toContain(usdgOnly);
    await api().get("/v1/super-agents/hireable?asset=btc").expect(400);
  });
});
