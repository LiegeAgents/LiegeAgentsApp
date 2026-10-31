import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("watch links", () => {
  let client: User;
  let provider: User;
  let jobId: string;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(provider);
    await credit(client.userId, 50);
    jobId = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
  });

  const share = (user: User) => api().post(`/v1/jobs/${jobId}/watch-link`).set(bearer(user));
  const watch = (token: string) => api().get(`/v1/watch/${token}`);

  test("anyone with the link sees live progress, and never the brief or delivery", async () => {
    const { token } = (await share(client).expect(201)).body.data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // Sharing again returns the same link.
    expect((await share(client).expect(201)).body.data.token).toBe(token);
    expect(
      (await api().get(`/v1/jobs/${jobId}/watch-link`).set(bearer(client)).expect(200)).body.data
        .token,
    ).toBe(token);

    const before = (await watch(token).expect(200)).body.data;
    expect(before).toMatchObject({ status: "funded", progress: [] });
    expect(before.agent.name).toBeTruthy();
    expect(before.fundedAt).toBeTruthy();

    await api()
      .post(`/v1/jobs/${jobId}/progress`)
      .set(bearer(provider))
      .send({ stage: "drafting", message: "Drafting the summary", percent: 60 })
      .expect(201);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "The secret delivery." })
      .expect(200);
    const response = await watch(token).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const after = response.body.data;
    expect(after).toMatchObject({
      status: "submitted",
      progress: [{ stage: "drafting", message: "Drafting the summary", percent: 60 }],
    });
    expect(after.submittedAt).toBeTruthy();
    const text = JSON.stringify(after);
    expect(text).not.toContain("The secret delivery.");
    expect(text).not.toContain("Summarize this week's market moves.");
    expect(text).not.toContain("budget");
  });

  test("only the client shares, and a revoked link stops working", async () => {
    await share(provider).expect(404);
    await share(await signIn()).expect(404);
    await api().get(`/v1/jobs/${jobId}/watch-link`).set(bearer(provider)).expect(404);
    expect(
      (await api().get(`/v1/jobs/${jobId}/watch-link`).set(bearer(client)).expect(200)).body.data,
    ).toBeNull();

    const { token } = (await share(client).expect(201)).body.data;
    await api().delete(`/v1/jobs/${jobId}/watch-link`).set(bearer(client)).expect(204);
    expect((await watch(token).expect(404)).body.error.code).toBe("watch_link_not_found");
    const fresh = (await share(client).expect(201)).body.data.token;
    expect(fresh).not.toBe(token);
    await watch(fresh).expect(200);
    await watch("not-a-token").expect(404);
  });
});
