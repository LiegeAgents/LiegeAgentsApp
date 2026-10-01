import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  api,
  bearer,
  clearData,
  databaseAvailable,
  rebuildSchema,
  signIn,
  createAgent,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("agent accounts and mandates", () => {
  let owner: User;
  let agentId: string;
  const privateKey = `0x${"b2".repeat(32)}` as const;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    owner = await signIn(privateKey);
    agentId = await createAgent(owner);
  });

  test("creates a deterministic account, enforces policy, and applies the kill switch", async () => {
    const account = await api()
      .post("/v1/agent-accounts")
      .set(bearer(owner))
      .send({ agentId })
      .expect(201);
    expect(account.body.data.accountId).toBe(agentId);
    expect(account.body.data.status).toBe("active");

    const simulated = await api()
      .post(`/v1/agent-accounts/${agentId}/actions/authorize`)
      .set(bearer(owner))
      .send({ action: "rebalance", amount: 10, simulate: true })
      .expect(200);
    expect(simulated.body.data.decision).toBe("simulation");

    await api()
      .put(`/v1/agent-accounts/${agentId}/policy`)
      .set(bearer(owner))
      .send({
        approvalMode: "within_policy",
        simulationRequired: false,
        allowedActions: ["rebalance"],
        dailyBudget: 20,
      })
      .expect(200);
    const approved = await api()
      .post(`/v1/agent-accounts/${agentId}/actions/authorize`)
      .set(bearer(owner))
      .send({ action: "rebalance", amount: 10 })
      .expect(200);
    expect(approved.body.data.decision).toBe("approved");

    await api()
      .post(`/v1/agent-accounts/${agentId}/control`)
      .set(bearer(owner))
      .send({ command: "kill", reason: "test stop" })
      .expect(200);
    const denied = await api()
      .post(`/v1/agent-accounts/${agentId}/actions/authorize`)
      .set(bearer(owner))
      .send({ action: "rebalance", amount: 1 })
      .expect(200);
    expect(denied.body.data.decision).toBe("denied");
    expect(denied.body.data.reasons).toContain("account_killed");
  });

  test("stores and verifies an owner-signed mandate before it can be revoked", async () => {
    await api().post("/v1/agent-accounts").set(bearer(owner)).send({ agentId }).expect(201);
    const nonce = `nonce-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const payload = { actions: ["rebalance"], maxAmount: "10" };
    const contents = { agentId, nonce, expiresAt, payload, parentMandateId: null };
    const canonical = JSON.stringify(contents, Object.keys(contents).sort());
    const digest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(canonical).digest("hex"),
    );
    const account = privateKeyToAccount(privateKey);
    const mandate = await api()
      .post(`/v1/agent-accounts/${agentId}/mandates`)
      .set(bearer(owner))
      .send({
        nonce,
        payload,
        expiresAt,
        signature: await account.signMessage({ message: `Liege Agent Mandate\n${digest}` }),
      })
      .expect(201);
    expect(mandate.body.data.status).toBe("active");
    await api()
      .post(`/v1/agent-accounts/${agentId}/mandates/${mandate.body.data.id}/revoke`)
      .set(bearer(owner))
      .expect(200);
  });
});
