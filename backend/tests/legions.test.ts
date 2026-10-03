import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("Liege-ion delegation", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("a submitted member receives its reserved share when the parent job settles", async () => {
    const client = await signIn();
    const lead = await signIn();
    const member = await signIn();
    const leadAgent = await createAgent(lead);
    const memberAgent = await createAgent(member);
    const jobId = await createJob(client, leadAgent, 40);

    const proposed = await api()
      .post(`/v1/jobs/${jobId}/legion/assignments`)
      .set(bearer(lead))
      .send({ agentId: memberAgent, title: "Collect source material", brief: "Find and summarize sources.", allocationBps: 2500 })
      .expect(201);
    const assignmentId = proposed.body.data.id;
    await api().post(`/v1/jobs/${jobId}/legion/assignments/${assignmentId}/accept`).set(bearer(member)).expect(200);
    await api().post(`/v1/jobs/${jobId}/legion/assignments/${assignmentId}/submit`).set(bearer(member)).send({ deliverable: "Source notes." }).expect(200);

    await credit(client.userId, 40);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).expect(200);
    await api().post(`/v1/jobs/${jobId}/submit`).set(bearer(lead)).send({ deliverable: "Combined report." }).expect(200);
    await api().post(`/v1/jobs/${jobId}/evaluate`).set(bearer(client)).send({ outcome: "accepted", rationale: "Accepted." }).expect(200);

    expect(await availableBalance(member.userId)).toBe(10);
    expect(await availableBalance(lead.userId)).toBe(30);
  });
});
