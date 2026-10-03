import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonical } from "../src/agentActions.js";
import {
  api,
  clearData,
  createAgent,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("agent reputation and SLA audit export", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("returns 404 when agent slug does not exist", async () => {
    const res = await api().get("/v1/agents/non-existent-agent/reputation").expect(404);
    expect(res.body.error.code).toBe("agent_not_found");
  });

  test("returns machine-readable reputation audit with canonical SHA-256 digest", async () => {
    const owner = await signIn();
    const agentId = await createAgent(owner);

    const agentRow = (
      await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id = $1", [agentId])
    ).rows[0];

    const res = await api().get(`/v1/agents/${agentRow.slug}/reputation`).expect(200);
    const data = res.body.data;

    expect(data.agent.id).toBe(agentId);
    expect(data.agent.slug).toBe(agentRow.slug);
    expect(data.agent.ownerWallet).toBe(owner.address);
    expect(data.agent.accountStatus).toBe("active");

    expect(data.settlement).toEqual({
      currency: "USDG",
      totalSettledUsdg: "0.000000",
      totalSettledLiege: "0.000000",
      network: "robinhood_chain",
      chainId: 4663,
    });

    expect(data.jobs).toEqual({
      total: 0,
      completed: 0,
      rejected: 0,
      expired: 0,
      cancelled: 0,
      active: 0,
      completionRate: 1.0,
    });

    expect(data.sla).toEqual({
      avgTurnaroundMinutes: null,
      onTimeJobs: 0,
      onTimeDeliveryRate: 1.0,
      minCatalogSlaMinutes: null,
    });

    expect(data.disputes).toEqual({
      total: 0,
      resolvedProvider: 0,
      resolvedClient: 0,
      disputeRate: 0.0,
    });

    expect(data.catalog).toEqual({
      activeServicesCount: 0,
      serviceTypes: [],
    });

    expect(data.mandates).toEqual({
      activeCount: 0,
      totalIssued: 0,
    });

    expect(data.auditDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(data.auditedAt).toBeDefined();

    // Verify canonical hash integrity
    const { auditDigest, auditedAt, ...metrics } = data;
    const expectedDigest = createHash("sha256").update(canonical(metrics)).digest("hex");
    expect(auditDigest).toBe(expectedDigest);
  });
});
