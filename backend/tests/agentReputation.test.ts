import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonical } from "../src/agentActions.js";
import { scoreReputation } from "../src/reputation.js";
import { badgeMessage, renderBadge } from "../src/agentBadge.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";

describe("reputation score", () => {
  const counts = {
    completed: 0,
    rejected: 0,
    undelivered: 0,
    onTime: 0,
    completedWithRevision: 0,
    disputesLost: 0,
  };

  test("is withheld until 5 outcomes, and a perfect short record is not a perfect score", () => {
    expect(scoreReputation({ ...counts, completed: 4, onTime: 4 })).toMatchObject({
      status: "not_scored",
      score: null,
      outcomes: 4,
    });
    const perfect = scoreReputation({ ...counts, completed: 5, onTime: 5 });
    expect(perfect).toMatchObject({ status: "scored", outcomes: 5 });
    expect(perfect.score).toBe(87);
    expect(scoreReputation({ ...counts, completed: 200, onTime: 200 }).score).toBe(100);
  });

  test("failures, lateness, revisions, and lost disputes all cost points", () => {
    const base = scoreReputation({ ...counts, completed: 20, onTime: 20 }).score!;
    for (const worse of [
      { rejected: 5 },
      { undelivered: 5 },
      { onTime: 10 },
      { completedWithRevision: 10 },
      { disputesLost: 3 },
    ])
      expect(
        scoreReputation({ ...counts, completed: 20, onTime: 20, ...worse }).score!,
      ).toBeLessThan(base);
    expect(scoreReputation({ ...counts, rejected: 10 }).score).toBeLessThan(20);
  });
});

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
  test("scores agents with enough outcomes and badges only verified, active Super Agents", async () => {
    const owner = await signIn();
    const client = await signIn();
    const agentId = await createAgent(owner);
    const jobs = await Promise.all(Array.from({ length: 6 }, () => createJob(client, agentId, 5)));
    // Four completed (three on time, one after a revision), one rejected, and one job that
    // expired before it was ever funded, which is not the agent's failure.
    await db.query(
      `UPDATE jobs SET
         status = CASE WHEN id = $2 THEN 'rejected'::job_status
                       WHEN id = $3 THEN 'expired'::job_status
                       ELSE 'completed'::job_status END,
         funded_at = CASE WHEN id = $3 THEN NULL ELSE now() - interval '2 hours' END,
         submitted_at = CASE WHEN id = $3 THEN NULL ELSE now() - interval '1 hour' END,
         settled_at = now(),
         deadline_at = CASE WHEN id = $1 THEN now() - interval '90 minutes' ELSE now() + interval '1 hour' END
       WHERE id = ANY($4::uuid[])`,
      [jobs[3], jobs[4], jobs[5], jobs],
    );
    await db.query(
      "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1, $2, 'job.revision_requested')",
      [jobs[0], client.userId],
    );
    const slug = (
      await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id = $1", [agentId])
    ).rows[0].slug;

    const audit = (await api().get(`/v1/agents/${slug}/reputation`).expect(200)).body.data;
    // delivery 5/7, on time 4/6, first pass 4/6, no disputes: 0.5*.714 + .25*.667 + .15*.667 + .1
    expect(audit.reputation).toMatchObject({
      status: "scored",
      score: 72,
      outcomes: 5,
      components: { delivery: 0.7143, onTime: 0.6667, firstPass: 0.6667, disputes: 1 },
      method: { minimumOutcomes: 5 },
    });
    expect(audit.agent).toMatchObject({ verifiedSuperAgent: false, verifiedAt: null });
    const { auditDigest, auditedAt, ...metrics } = audit;
    expect(auditDigest).toBe(createHash("sha256").update(canonical(metrics)).digest("hex"));

    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "rug-check",
          name: "Rug check",
          description: "Checks a token contract for rug-pull risk before you buy.",
          serviceType: "skill",
          priceUsd: 5,
          slaMinutes: 30,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,false,now())`,
      [agentId, service.id, hook.id],
    );
    const listed = async () =>
      (await api().get("/v1/agents").expect(200)).body.data.find(
        (agent: { id: string }) => agent.id === agentId,
      );
    // Verified once but disabled: no badge.
    expect((await listed()).verified).toBe(false);
    const badge = async () => {
      const response = await api().get(`/v1/agents/${slug}/badge.svg`).expect(200);
      expect(response.headers["content-type"]).toContain("image/svg+xml");
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      return String(response.body ?? response.text);
    };
    const unverified = await badge();
    expect(unverified).toContain(">score 72/100<");
    expect(unverified).not.toContain("Verified");
    await db.query("UPDATE superagent_enrollments SET enabled = true WHERE agent_id = $1", [
      agentId,
    ]);
    expect(await listed()).toMatchObject({
      verified: true,
      reputation: { status: "scored", score: 72 },
    });
    expect(
      (await api().get(`/v1/agents/${slug}/reputation`).expect(200)).body.data.agent,
    ).toMatchObject({ verifiedSuperAgent: true });
    const verified = await badge();
    expect(verified).toContain(">Verified · score 72/100<");
    expect(verified).toContain('fill="#12a36f"');
    const dashboard = (
      await api().get("/v1/super-agents/dashboard").set(bearer(client)).expect(200)
    ).body.data.agents.find((agent: { id: string }) => agent.id === agentId);
    expect(dashboard).toMatchObject({ verified: true, reputation: { score: 72 } });
  });

  test("a new agent's badge shows its empty record, and an unknown agent has none", async () => {
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const slug = (
      await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id = $1", [agentId])
    ).rows[0].slug;
    const response = await api().get(`/v1/agents/${slug}/badge.svg`).expect(200);
    expect(String(response.body ?? response.text)).toContain(">0 jobs on record<");
    expect(
      (await api().get("/v1/agents/no-such-agent/badge.svg").expect(404)).body.error.code,
    ).toBe("agent_not_found");
    await api().get("/v1/agents/Not_A_Slug/badge.svg").expect(400);
  });
});

describe("agent badge", () => {
  test("escapes the agent name and says what is recorded, never a rating", () => {
    const svg = renderBadge("Verified · 1 job on record", true, 'Anna <script>"x"</script>');
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("Anna &#60;script&#62;&#34;x&#34;&#60;/script&#62;");
    expect(badgeMessage(undefined)).toBe("0 jobs on record");
    expect(
      badgeMessage({
        verified: true,
        reputation: { status: "not_scored", score: null, outcomes: 1, reason: "" },
      }),
    ).toBe("Verified · 1 job on record");
  });
});
