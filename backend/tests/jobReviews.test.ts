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

describe.skipIf(!databaseAvailable)("job reviews", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let provider: User;
  let agentId: string;
  let slug: string;
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    slug = (await db.query("SELECT slug FROM agents WHERE id = $1", [agentId])).rows[0].slug;
    await credit(client.userId, 50);
  });

  async function delivered() {
    const jobId = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(provider))
      .send({ deliverable: "Report attached." })
      .expect(200);
    return jobId;
  }
  const decide = (jobId: string, outcome: "accepted" | "rejected") =>
    api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome, rationale: "Decided." })
      .expect(200);
  const review = (user: User, jobId: string, body: object) =>
    api().post(`/v1/jobs/${jobId}/review`).set(bearer(user)).send(body);

  test("the client reviews a finished job, the owner is told and replies once", async () => {
    const jobId = await delivered();
    expect((await review(client, jobId, { rating: 5 }).expect(409)).body.error.code).toBe(
      "review_not_available",
    );
    await decide(jobId, "accepted");
    await review(provider, jobId, { rating: 5 }).expect(404);
    await review(client, jobId, { rating: 6 }).expect(400);
    await review(client, jobId, { rating: 4, comment: "x".repeat(1001) }).expect(400);
    const created = (
      await review(client, jobId, { rating: 4, comment: "  Clear, sourced brief.\u0007 " }).expect(
        201,
      )
    ).body.data;
    expect(created).toMatchObject({ rating: 4, comment: "Clear, sourced brief.", reply: null });
    // Editing within 14 days updates it and does not notify again.
    await review(client, jobId, { rating: 5, comment: "Clear, sourced brief." }).expect(200);
    const notes = await db.query(
      "SELECT title, message FROM notifications WHERE user_id = $1 AND event_type = 'job.reviewed'",
      [provider.userId],
    );
    expect(notes.rows).toEqual([
      {
        title: "New 4-star review for Research Agent",
        message: '"Clear, sourced brief." You can reply on the job page.',
      },
    ]);

    const reply = (user: User, text: string) =>
      api().post(`/v1/jobs/${jobId}/review/reply`).set(bearer(user)).send({ reply: text });
    await reply(client, "Thanks").expect(404);
    await reply(provider, "").expect(400);
    expect((await reply(provider, "Thank you!").expect(200)).body.data.reply).toBe("Thank you!");
    expect((await reply(provider, "Again").expect(409)).body.error.code).toBe(
      "review_already_answered",
    );
    const detail = (await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200)).body.data;
    expect(detail.review).toMatchObject({ rating: 5, reply: "Thank you!", editable: true });
  });

  test("reviews lock after 14 days, and rejected jobs can be reviewed", async () => {
    const accepted = await delivered();
    await decide(accepted, "accepted");
    await review(client, accepted, { rating: 2 }).expect(201);
    await db.query("UPDATE job_reviews SET created_at = now() - interval '15 days'");
    expect((await review(client, accepted, { rating: 5 }).expect(409)).body.error.code).toBe(
      "review_locked",
    );
    const rejected = await delivered();
    await decide(rejected, "rejected");
    await review(client, rejected, { rating: 1, comment: "Missed the brief." }).expect(201);
  });

  test("profiles show a summary and anonymous reviews; the score ignores them", async () => {
    const before = (await api().get(`/v1/agents/${slug}/reputation`).expect(200)).body.data;
    for (const [rating, comment] of [
      [5, "Excellent."],
      [3, null],
      [4, "Good."],
    ] as const) {
      const jobId = await delivered();
      await decide(jobId, "accepted");
      await review(client, jobId, { rating, ...(comment ? { comment } : {}) }).expect(201);
    }
    const page = (await api().get(`/v1/agents/${slug}/reviews?limit=2`).expect(200)).body.data;
    expect(page).toMatchObject({
      count: 3,
      average: 4,
      distribution: { "1": 0, "2": 0, "3": 1, "4": 1, "5": 1 },
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ rating: 4, comment: "Good.", job_status: "completed" });
    expect(page.items[0]).not.toHaveProperty("client_id");
    const next = (
      await api()
        .get(`/v1/agents/${slug}/reviews?limit=2&before=${encodeURIComponent(page.nextCursor)}`)
        .expect(200)
    ).body.data;
    expect(next.items.map((item: { rating: number }) => item.rating)).toEqual([5]);
    expect(next.nextCursor).toBeNull();

    const listed = (await api().get("/v1/agents").expect(200)).body.data.find(
      (agent: { id: string }) => agent.id === agentId,
    );
    expect(listed.reviews).toEqual({ count: 3, average: 4 });
    await api().get("/v1/agents/nobody/reviews").expect(404);
    // Ratings never feed the outcome-based reputation.
    const after = (await api().get(`/v1/agents/${slug}/reputation`).expect(200)).body.data;
    expect(after.jobs.completed).toBe(before.jobs.completed + 3);
    expect(JSON.stringify(after)).not.toContain("rating");
  });
});
