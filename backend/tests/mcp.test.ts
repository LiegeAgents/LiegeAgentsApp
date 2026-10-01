import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  credit,
  createAgent,
  createJob,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

const internalHeaders = (connectionToken: string) => ({
  "x-mcp-internal-token": process.env.MCP_INTERNAL_API_TOKEN!,
  "x-mcp-connection-token": connectionToken,
});

describe.skipIf(!databaseAvailable)("MCP connections", () => {
  let owner: User;
  let client: User;
  let agentId: string;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [owner, client] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(owner);
  });

  async function connect() {
    const response = await api()
      .post("/v1/mcp/connections")
      .set(bearer(owner))
      .send({ agentId, name: "Local MCP" })
      .expect(201);
    expect(response.body.data.token).toMatch(/^lmp_[a-f0-9]{64}$/);
    return response.body.data as { id: string; token: string };
  }

  test("binds a token to its owner agent and exposes only that agent's work", async () => {
    const connection = await connect();
    const jobId = await createJob(client, agentId, 25);

    const session = await api()
      .get("/v1/internal/mcp/session")
      .set(internalHeaders(connection.token))
      .expect(200);
    expect(session.body.data.agentId).toBe(agentId);

    const jobs = await api()
      .get("/v1/internal/mcp/jobs")
      .set(internalHeaders(connection.token))
      .expect(200);
    expect(jobs.body.data.map((job: { id: string }) => job.id)).toEqual([jobId]);

    const detail = await api()
      .get(`/v1/internal/mcp/jobs/${jobId}`)
      .set(internalHeaders(connection.token))
      .expect(200);
    expect(detail.body.data.brief).toBe("Summarize this week's market moves.");
  });

  test("requires both service and connection credentials, and revocation takes effect", async () => {
    const connection = await connect();
    await api()
      .get("/v1/internal/mcp/session")
      .set("x-mcp-connection-token", connection.token)
      .expect(401);
    await api()
      .get("/v1/internal/mcp/session")
      .set({ ...internalHeaders(connection.token), "x-mcp-connection-token": "lmp_invalid" })
      .expect(401);

    await api().delete(`/v1/mcp/connections/${connection.id}`).set(bearer(owner)).expect(204);
    await api().get("/v1/internal/mcp/session").set(internalHeaders(connection.token)).expect(401);
  });

  test("enforces brief-only access and audits a denied none policy", async () => {
    await credit(client.userId, 100);
    const jobId = await createJob(client, agentId, 25);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "Private report" })
      .expect(200);
    await api()
      .put(`/v1/mcp/policies/${agentId}`)
      .set(bearer(owner))
      .send({ payloadAccess: "brief" })
      .expect(200);
    const connection = await connect();
    const briefOnly = await api()
      .get(`/v1/internal/mcp/jobs/${jobId}`)
      .set(internalHeaders(connection.token))
      .expect(200);
    expect(briefOnly.body.data.brief).toBe("Summarize this week's market moves.");
    expect(briefOnly.body.data.submission).toBeNull();

    await api()
      .put(`/v1/mcp/policies/${agentId}`)
      .set(bearer(owner))
      .send({ payloadAccess: "none" })
      .expect(200);
    await api()
      .get(`/v1/internal/mcp/jobs/${jobId}`)
      .set(internalHeaders(connection.token))
      .expect(200);
    const denied = await db.query(
      `SELECT metadata->>'code' AS code FROM audit_logs
       WHERE action = 'job.payload_access_denied' AND target_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [jobId],
    );
    expect(denied.rows[0].code).toBe("payload_policy_denied");
  });

  test("creates a website approval proposal without performing an action", async () => {
    const connection = await connect();
    const created = await api()
      .post("/v1/internal/mcp/proposals")
      .set(internalHeaders(connection.token))
      .send({ action: "accept_job", payload: { jobId: crypto.randomUUID() } })
      .expect(201);
    expect(created.body.data.status).toBe("pending");

    const proposals = await api().get("/v1/mcp/proposals").set(bearer(owner)).expect(200);
    expect(proposals.body.data).toHaveLength(1);
    expect(proposals.body.data[0].status).toBe("pending");

    await api()
      .post(`/v1/mcp/proposals/${created.body.data.id}/approved`)
      .set(bearer(owner))
      .expect(200);
    const updated = await api().get("/v1/mcp/proposals").set(bearer(owner)).expect(200);
    expect(updated.body.data[0].status).toBe("approved");
  });

  test("refuses approvals while the agent is paused and ends runtime access on kill", async () => {
    const connection = await connect();
    const queued = await api()
      .post("/v1/internal/mcp/proposals")
      .set(internalHeaders(connection.token))
      .send({ action: "accept_job", payload: { jobId: crypto.randomUUID() } })
      .expect(201);
    const control = (command: string) =>
      api()
        .post(`/v1/agent-accounts/${agentId}/control`)
        .set(bearer(owner))
        .send({ command, reason: "kill switch test" })
        .expect(200);

    await control("pause");
    const blocked = await api()
      .post(`/v1/mcp/proposals/${queued.body.data.id}/approved`)
      .set(bearer(owner))
      .expect(403);
    expect(blocked.body.error.code).toBe("agent_account_paused");

    await control("resume");
    const second = await api()
      .post("/v1/internal/mcp/proposals")
      .set(internalHeaders(connection.token))
      .send({ action: "accept_job", payload: { jobId: crypto.randomUUID() } })
      .expect(201);
    const killed = await control("kill");
    expect(killed.body.data.revokedConnections).toBe(1);
    expect(killed.body.data.rejectedProposals).toBe(2);

    const proposals = await api().get("/v1/mcp/proposals").set(bearer(owner)).expect(200);
    expect(proposals.body.data.map((item: { status: string }) => item.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(second.body.data.status).toBe("pending");
    await api().get("/v1/internal/mcp/session").set(internalHeaders(connection.token)).expect(401);
  });

  test("does not let another wallet create or decide an owner's MCP records", async () => {
    await api()
      .post("/v1/mcp/connections")
      .set(bearer(client))
      .send({ agentId, name: "Not mine" })
      .expect(404);
    const connection = await connect();
    const proposal = await api()
      .post("/v1/internal/mcp/proposals")
      .set(internalHeaders(connection.token))
      .send({ action: "update_agent", payload: { name: "Changed" } })
      .expect(201);
    await api()
      .post(`/v1/mcp/proposals/${proposal.body.data.id}/approved`)
      .set(bearer(client))
      .expect(409);
  });
});
