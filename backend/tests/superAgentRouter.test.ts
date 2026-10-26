import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { env } from "../src/config.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { keywordRoute, routeRequest, routerTransport } from "../src/superAgentRouter.js";

const candidate = (id: string, service: string, description: string) => ({
  id,
  slug: id,
  name: id,
  category: null,
  service,
  description,
});

describe("keyword routing", () => {
  const marcus = candidate(
    "marcus",
    "Code review",
    "Reviews pull requests for bugs and security issues.",
  );
  const anna = candidate(
    "anna",
    "Research brief",
    "Researches markets and competitors with sources.",
  );

  test("picks the service that shares the most words with the request", () => {
    expect(
      keywordRoute("Please review my pull request for security bugs", [anna, marcus]),
    ).toMatchObject({
      agentId: "marcus",
      method: "keywords",
    });
    const research = keywordRoute("Research our top competitors in payments", [marcus, anna]);
    expect(research?.agentId).toBe("anna");
    expect(research?.reason).toContain("competitor");
  });

  test("picks nobody when nothing matches", () => {
    expect(keywordRoute("Bake me a cake", [marcus, anna])).toBeNull();
  });
});

describe.skipIf(!databaseAvailable)("Super Agent router", () => {
  beforeAll(rebuildSchema);
  let client: User;
  const spies: Array<{ mockRestore(): void }> = [];
  const originalKey = env.GROQ_API_KEY;
  beforeEach(async () => {
    await clearData();
    client = await signIn();
    env.GROQ_API_KEY = undefined;
  });
  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    env.GROQ_API_KEY = originalKey;
  });

  /** A verified, enabled Super Agent selling one service at 3 USD. */
  async function enroll(slug: string, name: string, description: string) {
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug,
          name,
          description,
          serviceType: "skill",
          priceUsd: 3,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,now())`,
      [agentId, service.id, hook.id],
    );
    return agentId;
  }

  test("a request that names no agent goes to the best-fitting one, with the reason", async () => {
    const research = await enroll(
      "research-brief",
      "Research brief",
      "Researches markets and competitors with cited sources.",
    );
    await enroll(
      "code-review",
      "Code review",
      "Reviews pull requests for bugs and security issues.",
    );
    const preview = (
      await api()
        .post("/v1/super-agents/intents/parse")
        .set(bearer(client))
        .send({ text: "Research the top five competitors in onchain payments, budget 3 USDG" })
        .expect(200)
    ).body.data;
    expect(preview.routed).toMatchObject({ agentId: research, method: "keywords" });
    expect(preview.quote.agentId).toBe(research);

    const created = (
      await api()
        .post("/v1/super-agents/intents")
        .set(bearer(client))
        .send({ text: "Research the top five competitors in onchain payments, budget 3 USDG" })
        .expect(201)
    ).body.data;
    expect(created.agent_id).toBe(research);
    expect(created.status).toBe("pending");
    expect(created.parsed.routedReason).toContain("competitor");
  });

  test("with a model, its pick wins; an out-of-range answer falls back to keywords", async () => {
    const research = await enroll(
      "research-brief",
      "Research brief",
      "Researches markets and competitors.",
    );
    const review = await enroll("code-review", "Code review", "Reviews pull requests.");
    env.GROQ_API_KEY = "test-key";
    let reply = JSON.stringify({ index: 1, reason: "It asks for a review of code changes." });
    spies.push(spyOn(routerTransport, "complete").mockImplementation(async () => reply));
    expect(await routeRequest("Look over my changes before I merge", "usdg")).toMatchObject({
      agentId: review,
      method: "model",
      reason: "It asks for a review of code changes.",
    });
    reply = JSON.stringify({ index: 7, reason: "Made up." });
    expect((await routeRequest("Research competitors", "usdg"))?.agentId).toBe(research);
    // The model can decline to pick; then nobody is chosen.
    reply = JSON.stringify({ index: null, reason: "Nothing fits." });
    expect(await routeRequest("Bake a cake", "usdg")).toBeNull();
  });

  test("when nothing fits, the proposal asks for more detail", async () => {
    await enroll("code-review", "Code review", "Reviews pull requests for bugs.");
    const refused = await api()
      .post("/v1/super-agents/intents")
      .set(bearer(client))
      .send({ text: "Bake a birthday cake, budget 3 USDG" })
      .expect(422);
    expect(refused.body.error.message).toContain("No enrolled Super Agent's service fits");
  });
});
