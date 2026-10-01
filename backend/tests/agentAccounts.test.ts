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

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

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

    const simulation = await api()
      .post(`/v1/agent-accounts/${agentId}/actions/simulate`)
      .set(bearer(owner))
      .send({ action: "rebalance", amount: 5, details: { venue: "paper" } })
      .expect(201);
    const pending = await api()
      .post(`/v1/agent-accounts/${agentId}/actions/authorize`)
      .set(bearer(owner))
      .send({
        action: "rebalance",
        amount: 5,
        details: { venue: "paper" },
        simulationId: simulation.body.data.id,
      })
      .expect(200);
    expect(pending.body.data.decision).toBe("approval_required");
    await api()
      .post(`/v1/agent-accounts/${agentId}/actions/${pending.body.data.actionId}/approve`)
      .set(bearer(owner))
      .expect(200);

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

  test("holds large actions for the owner and denies actions outside active hours", async () => {
    await api().post("/v1/agent-accounts").set(bearer(owner)).send({ agentId }).expect(201);
    const policy = (rules: object) =>
      api()
        .put(`/v1/agent-accounts/${agentId}/policy`)
        .set(bearer(owner))
        .send({ approvalMode: "within_policy", simulationRequired: false, ...rules });
    const authorize = (amount: number) =>
      api()
        .post(`/v1/agent-accounts/${agentId}/actions/authorize`)
        .set(bearer(owner))
        .send({ action: "rebalance", amount })
        .expect(200);

    const saved = await policy({ requireHumanAbove: 50, timezone: "Africa/Lagos" }).expect(200);
    expect(Number(saved.body.data.policy.requireHumanAbove)).toBe(50);
    expect(saved.body.data.policy.timezone).toBe("Africa/Lagos");
    expect((await authorize(10)).body.data.decision).toBe("approved");
    const held = await authorize(60);
    expect(held.body.data.decision).toBe("approval_required");
    expect(held.body.data.reasons).toEqual(["human_approval_required"]);

    // A one-hour window that starts an hour from now never contains the current time.
    const hour = new Date().getUTCHours();
    await policy({ activeHours: { start: (hour + 1) % 24, end: (hour + 2) % 24 } }).expect(200);
    const outside = await authorize(10);
    expect(outside.body.data.decision).toBe("denied");
    expect(outside.body.data.reasons).toContain("outside_active_hours");

    const account = await api().get(`/v1/agent-accounts/${agentId}`).set(bearer(owner)).expect(200);
    expect(account.body.data.policy.activeHours).toEqual({
      start: (hour + 1) % 24,
      end: (hour + 2) % 24,
    });
    await policy({ timezone: "Mars/Olympus" }).expect(400);
    await policy({ activeHours: { start: 9, end: 9 } }).expect(400);
  });

  test("stores and verifies an owner-signed mandate before it can be revoked", async () => {
    await api().post("/v1/agent-accounts").set(bearer(owner)).send({ agentId }).expect(201);
    const nonce = `nonce-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const payload = { actions: ["rebalance"], maxAmount: "10" };
    const contents = { agentId, nonce, expiresAt, payload, parentMandateId: null };
    const digest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(canonical(contents)).digest("hex"),
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
