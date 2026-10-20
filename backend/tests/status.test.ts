import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { resetStatusCache, statusTransport } from "../src/status.js";

describe.skipIf(!databaseAvailable)("platform status", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    resetStatusCache();
  });
  const original = statusTransport.health;
  afterEach(() => {
    statusTransport.health = original;
  });

  /** A Super Agent whose webhook points at `url`, verified unless told otherwise. */
  async function superAgent(owner: User, url: string, verified = true) {
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: `service-${crypto.randomUUID().slice(0, 8)}`,
          name: "Research brief",
          description: "A cited research brief.",
          serviceType: "skill",
          priceUsd: 5,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, url, ["job.funded"]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,$4)`,
      [agentId, service.id, hook.id, verified ? new Date() : null],
    );
    return (await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id=$1", [agentId]))
      .rows[0].slug;
  }

  test("reports each verified Super Agent as its runtime reports it, checking each runtime once", async () => {
    const owner = await signIn();
    const anna = await superAgent(owner, "https://8.8.8.8/webhooks/anna");
    const kori = await superAgent(owner, "https://8.8.8.8/webhooks/kori");
    const other = await superAgent(owner, "https://1.1.1.1/hook");
    await superAgent(owner, "https://8.8.8.8/webhooks/scott", false);
    const calls: string[] = [];
    statusTransport.health = async (url) => {
      calls.push(url);
      return url.startsWith("https://8.8.8.8")
        ? { ok: true, body: { data: { status: "ok", agents: ["anna", "scott"] } } }
        : { ok: true, body: { status: "ok" } };
    };

    const response = await api().get("/v1/status").expect(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
    const status = response.body.data;
    expect(status).toMatchObject({ api: { status: "ok" }, database: "ok" });
    const bySlug = Object.fromEntries(
      status.superAgents.map((agent: { slug: string; status: string }) => [
        agent.slug,
        agent.status,
      ]),
    );
    // Scott's runtime lists him, but he is not verified, so he is not on the page at all.
    expect(bySlug).toEqual({ [anna]: "online", [kori]: "offline", [other]: "unreported" });
    expect(status.summary).toEqual({ online: 1, total: 3 });
    expect(calls.sort()).toEqual(["https://1.1.1.1/health", "https://8.8.8.8/health"]);

    // Within a minute the same answer is reused instead of checking the runtimes again.
    await api().get("/v1/status").expect(200);
    expect(calls).toHaveLength(2);
  });

  test("an unreachable runtime shows its agents offline", async () => {
    const owner = await signIn();
    const anna = await superAgent(owner, "https://8.8.8.8/webhooks/anna");
    statusTransport.health = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const status = (await api().get("/v1/status").expect(200)).body.data;
    expect(status.superAgents).toEqual([
      expect.objectContaining({ slug: anna, status: "offline" }),
    ]);
    expect(status.summary).toEqual({ online: 0, total: 1 });
  });
});
