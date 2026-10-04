import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { adminKey } from "./setup.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  db,
  openJob,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

let admin: User;
let client: User;
let evaluator: User;
let agentId: string;

const setStake = (stakeUsdg: number) =>
  api()
    .post("/v1/admin/evaluators/stake")
    .set(bearer(admin))
    .send({ userId: evaluator.userId, stakeUsdg, reference: `stake-${crypto.randomUUID()}` });

describe.skipIf(!databaseAvailable)("evaluator capacity", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    let provider: User;
    [admin, client, provider, evaluator] = await Promise.all([
      signIn(adminKey),
      signIn(),
      signIn(),
      signIn(),
    ]);
    agentId = await createAgent(provider);
    await credit(evaluator.userId, 5000);
    await setStake(5000).expect(200);
    await api().put("/v1/evaluators/me").set(bearer(evaluator)).send({ active: true }).expect(200);
  });

  const assign = (budgetUsdg: number) =>
    openJob(client, agentId, budgetUsdg, { evaluatorId: evaluator.userId });

  test("an evaluator's open jobs together cannot exceed a fifth of their stake", async () => {
    await assign(600).expect(201);
    const refused = await assign(600).expect(422);
    expect(refused.body.error.code).toBe("evaluator_capacity_exceeded");
    await assign(400).expect(201);
  });

  test("concurrent assignments cannot overcommit an evaluator", async () => {
    const responses = await Promise.all([assign(600), assign(600)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
  });

  test("expired jobs release their exposure", async () => {
    const jobId = await createJob(client, agentId, 1000, { evaluatorId: evaluator.userId });
    await assign(1).expect(422);
    await db.query(
      "UPDATE jobs SET deadline_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
      [jobId],
    );
    await api()
      .post("/v1/cron/expire-jobs")
      .set("x-cron-secret", process.env.CRON_SECRET!)
      .send({ idempotencyKey: crypto.randomUUID() })
      .expect(200);
    await assign(1000).expect(201);
  });

  test("stake cannot be lowered below what open jobs need", async () => {
    await assign(600).expect(201);
    const refused = await setStake(2000).expect(409);
    expect(refused.body.error.code).toBe("stake_backs_open_jobs");
    await setStake(3000).expect(200);
  });

  test("jobs of 50 USDG or more need an independent evaluator", async () => {
    await openJob(client, agentId, 49.99).expect(201);
    const unassigned = await openJob(client, agentId, 50).expect(422);
    expect(unassigned.body.error.code).toBe("self_evaluation_limit");
    const selfAssigned = await openJob(client, agentId, 50, { evaluatorId: client.userId });
    expect(selfAssigned.status).toBe(422);
    expect(selfAssigned.body.error.code).toBe("self_evaluation_limit");
  });

  test("LIEGE jobs use the same independent-review and stake-capacity controls", async () => {
    await credit(evaluator.userId, 10_000_000, "liege");
    await api()
      .post("/v1/admin/evaluators/stake")
      .set(bearer(admin))
      .send({
        userId: evaluator.userId,
        stakeAmount: 10_000_000,
        settlementAsset: "liege",
        reference: `stake-liege-${crypto.randomUUID()}`,
      })
      .expect(200);
    const base = {
      settlementAsset: "liege",
      budgetLiege: "600",
      evaluatorId: evaluator.userId,
    };
    await openJob(client, agentId, 1, base).expect(201);
    const overCapacity = await openJob(client, agentId, 1, base).expect(422);
    expect(overCapacity.body.error.code).toBe("evaluator_capacity_exceeded");
    const selfSettled = await openJob(client, agentId, 1, {
      settlementAsset: "liege",
      budgetLiege: "50",
    }).expect(422);
    expect(selfSettled.body.error.code).toBe("self_evaluation_limit");
  });
});
