import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("agent memory", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let provider: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    await credit(client.userId, 100);
  });

  const funded = async () => {
    const jobId = await createJob(client, agentId, 5);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    return jobId;
  };
  /** A job the client sent back once with this feedback. */
  async function revised(feedback: string) {
    const jobId = await funded();
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "First draft." })
      .expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/revision`)
      .set(bearer(client))
      .send({ feedback })
      .expect(200);
    return jobId;
  }
  const memoryFor = (jobId: string, user = provider) =>
    api().get(`/v1/jobs/${jobId}/memory`).set(bearer(user));
  const setMemory = (body: object) =>
    api().put(`/v1/super-agents/memory/${agentId}`).set(bearer(client)).send(body);

  test("the agent reads the client's preferences and earlier feedback while working", async () => {
    const earlier = await revised("Put a one-line summary at the top.");
    await setMemory({ preferences: "Use bullet points and cite every source." }).expect(200);
    const current = await funded();
    const memory = (await memoryFor(current).expect(200)).body.data;
    expect(memory).toMatchObject({
      enabled: true,
      preferences: "Use bullet points and cite every source.",
      learned: [{ jobTitle: "Market summary", feedback: "Put a one-line summary at the top." }],
    });
    // A job's own revision is not repeated back to it.
    expect((await memoryFor(earlier).expect(200)).body.data.learned).toEqual([]);
    // Stored encrypted.
    const row = await db.query("SELECT preferences_ciphertext FROM agent_memory");
    expect(row.rows[0].preferences_ciphertext).not.toContain("bullet");

    // The client sees what each agent remembers.
    const list = (await api().get("/v1/super-agents/memory").set(bearer(client)).expect(200)).body
      .data;
    expect(list[0]).toMatchObject({
      agentId,
      preferences: "Use bullet points and cite every source.",
    });
    expect(list[0].learned).toHaveLength(1);
  });

  test("off means the agent gets nothing, and clearing forgets the past", async () => {
    await revised("Shorter, please.");
    await setMemory({ preferences: "Plain language." }).expect(200);
    const current = await funded();
    await setMemory({ enabled: false }).expect(200);
    expect((await memoryFor(current).expect(200)).body.data).toEqual({
      enabled: false,
      preferences: null,
      learned: [],
    });
    await setMemory({ enabled: true }).expect(200);
    const cleared = (
      await api().delete(`/v1/super-agents/memory/${agentId}`).set(bearer(client)).expect(200)
    ).body.data;
    expect(cleared).toEqual({ enabled: true, preferences: null, learned: [] });
    expect((await memoryFor(current).expect(200)).body.data.learned).toEqual([]);
    // Feedback given after clearing is remembered again.
    await revised("Add a table.");
    expect((await memoryFor(current).expect(200)).body.data.learned).toHaveLength(1);
  });

  test("only the agent's owner, and only while working the job", async () => {
    const current = await funded();
    await memoryFor(current, client).expect(404);
    const stranger = await signIn();
    await memoryFor(current, stranger).expect(404);
    await api()
      .post(`/v1/jobs/${current}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Done." })
      .expect(200);
    expect((await memoryFor(current).expect(409)).body.error.code).toBe("job_not_in_progress");
    await setMemory({ preferences: "x".repeat(2001) }).expect(400);
  });
});
