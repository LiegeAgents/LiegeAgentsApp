import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonical } from "../src/agentActions.js";
import {
  api,
  clearData,
  createAgent,
  createJob,
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
      completionRate: null,
    });

    expect(data.sla).toEqual({
      avgTurnaroundMinutes: null,
      onTimeJobs: 0,
      onTimeDeliveryRate: null,
      minCatalogSlaMinutes: null,
    });

    expect(data.performance).toEqual({
      source: "liege_job_lifecycle",
      completedJobs: 0,
      onTimeCompletedJobs: 0,
      onTimeDeliveryRate: null,
      rejectedJobs: 0,
      expiredJobs: 0,
      cancelledJobs: 0,
      jobsWithRevisionRequests: 0,
      revisionRequests: 0,
      lastCompletedAt: null,
    });
    expect(data.agent.reputationScoreStatus).toBe("not_scored");

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

  test("reports lifecycle outcomes, on-time delivery, and revisions with explicit samples", async () => {
    const owner = await signIn();
    const client = await signIn();
    const agentId = await createAgent(owner);
    const completedOnTime = await createJob(client, agentId, 5);
    const completedLate = await createJob(client, agentId, 5);
    const rejected = await createJob(client, agentId, 5);
    const expired = await createJob(client, agentId, 5);
    const cancelled = await createJob(client, agentId, 5);

    await db.query(
      `UPDATE jobs SET
         status = CASE id
           WHEN $1 THEN 'completed'::job_status
           WHEN $2 THEN 'completed'::job_status
           WHEN $3 THEN 'rejected'::job_status
           WHEN $4 THEN 'expired'::job_status
           WHEN $5 THEN 'cancelled'::job_status
         END,
         funded_at = now() - interval '2 hours',
         submitted_at = CASE WHEN id = $1 THEN now() - interval '1 hour'
                             WHEN id = $2 THEN now() - interval '1 hour' END,
         settled_at = CASE WHEN id IN ($1, $2, $3, $4) THEN now() END,
         deadline_at = CASE WHEN id = $2 THEN now() - interval '90 minutes'
                            ELSE now() + interval '1 hour' END
       WHERE id = ANY($6::uuid[])`,
      [
        completedOnTime,
        completedLate,
        rejected,
        expired,
        cancelled,
        [completedOnTime, completedLate, rejected, expired, cancelled],
      ],
    );
    await db.query(
      "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1, $2, 'job.revision_requested')",
      [completedOnTime, client.userId],
    );

    const agent = (
      await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id = $1", [agentId])
    ).rows[0];
    const response = await api().get(`/v1/agents/${agent.slug}/reputation`).expect(200);
    expect(response.body.data.performance).toMatchObject({
      source: "liege_job_lifecycle",
      completedJobs: 2,
      onTimeCompletedJobs: 1,
      onTimeDeliveryRate: 0.5,
      rejectedJobs: 1,
      expiredJobs: 1,
      cancelledJobs: 1,
      jobsWithRevisionRequests: 1,
      revisionRequests: 1,
    });
    expect(response.body.data.jobs).toMatchObject({
      completed: 2,
      rejected: 1,
      expired: 1,
      cancelled: 1,
    });
    expect(response.body.data.performance.lastCompletedAt).toBeTruthy();

    const { auditDigest, auditedAt, ...metrics } = response.body.data;
    expect(auditDigest).toBe(createHash("sha256").update(canonical(metrics)).digest("hex"));
    expect(auditedAt).toBeDefined();
  });
});
