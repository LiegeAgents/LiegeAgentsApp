import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

describe.skipIf(!databaseAvailable)("GitHub triggers", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function setup(body: object = {}) {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    await db.query("UPDATE agents SET name='Marcus' WHERE id=$1", [agentId]);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "code-review",
          name: "Code review",
          description: "Marcus reviews code for bugs and security issues.",
          serviceType: "skill",
          priceUsd: 5,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at)
       VALUES ($1,$2,$3,true,now())`,
      [agentId, service.id, hook.id],
    );
    await credit(client.userId, 100);
    const created = await api()
      .post("/v1/super-agents/triggers")
      .set(bearer(client))
      .send({
        agentId,
        repository: "https://github.com/acme/shop",
        budgetAmount: 4,
        spendCap: 10,
        autoFund: true,
        ...body,
      })
      .expect(201);
    return { owner, client, stranger, agentId, trigger: created.body.data };
  }

  // Sends what GitHub sends: the raw JSON body signed with the trigger's secret.
  function deliver(
    trigger: { id: string; setup: { secret: string } },
    event: string,
    payload: object,
    delivery = crypto.randomUUID(),
    secret = trigger.setup.secret,
  ) {
    const body = JSON.stringify(payload);
    return api()
      .post(`/v1/github/hooks/${trigger.id}`)
      .set({
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      })
      .send(body);
  }

  const pullRequest = (number: number, head: string, extra: object = {}) => ({
    action: "opened",
    repository: { full_name: "acme/shop", private: false },
    pull_request: {
      number,
      title: `Add checkout #${number}`,
      html_url: `https://github.com/acme/shop/pull/${number}`,
      draft: false,
      base: { ref: "main" },
      head: { sha: head },
      ...extra,
    },
  });

  test("a pull request to main opens and funds a review of exactly that commit", async () => {
    const { owner, client, trigger } = await setup();
    expect(trigger).toMatchObject({ repository: "acme/shop", branch: "main", verified_at: null });
    expect(trigger.setup).toMatchObject({
      payloadUrl: `https://api.liegeagents.com/v1/github/hooks/${trigger.id}`,
      contentType: "application/json",
      events: ["pull_request"],
      settingsUrl: "https://github.com/acme/shop/settings/hooks/new",
    });
    expect(trigger.setup.secret).toMatch(/^[0-9a-f]{64}$/);

    const ping = await deliver(trigger, "ping", { repository: { full_name: "acme/shop" } }).expect(
      200,
    );
    expect(ping.body.data.status).toBe("connected");

    const delivery = crypto.randomUUID();
    const run = await deliver(trigger, "pull_request", pullRequest(7, sha(1)), delivery).expect(
      202,
    );
    expect(run.body.data.status).toBe("funded");
    const jobId = run.body.data.jobId;
    const job = await db.query("SELECT title, status, strategy_policy FROM jobs WHERE id=$1", [
      jobId,
    ]);
    expect(job.rows[0]).toMatchObject({
      title: "Review acme/shop#7: Add checkout #7",
      status: "funded",
    });
    expect(job.rows[0].strategy_policy).toMatchObject({
      triggerId: trigger.id,
      github: { repository: "acme/shop", pull: 7, headSha: sha(1), postComment: true },
    });
    expect(await availableBalance(client.userId)).toBe(96);
    const attachments = await api()
      .get(`/v1/jobs/${jobId}/attachments`)
      .set(bearer(owner))
      .expect(200);
    const link = await api()
      .get(`/v1/jobs/${jobId}/attachments/${attachments.body.data[0].id}`)
      .set(bearer(owner))
      .expect(200);
    expect(link.body.data).toMatchObject({
      url: "https://github.com/acme/shop/pull/7",
      commit: sha(1),
    });

    // GitHub redelivers the same event: no second job.
    const again = await deliver(trigger, "pull_request", pullRequest(7, sha(1)), delivery).expect(
      202,
    );
    expect(again.body.data.reason).toBe("duplicate_delivery");
    // A push while the review runs does not pile up jobs.
    const busy = await deliver(trigger, "pull_request", {
      ...pullRequest(7, sha(2)),
      action: "synchronize",
    }).expect(202);
    expect(busy.body.data).toMatchObject({ status: "skipped", detail: "Already reviewing #7." });

    const view = (await api().get("/v1/super-agents/triggers").set(bearer(client)).expect(200)).body
      .data[0];
    expect(view.verified_at).not.toBeNull();
    expect(view.runs.map((item: { outcome: string }) => item.outcome)).toEqual([
      "skipped",
      "funded",
    ]);
    expect(view.setup).toBeUndefined();
  });

  test("the spending cap ends the trigger", async () => {
    const { trigger } = await setup({ budgetAmount: 4, spendCap: 8 });
    await deliver(trigger, "pull_request", pullRequest(1, sha(1))).expect(202);
    const second = await deliver(trigger, "pull_request", pullRequest(2, sha(2))).expect(202);
    expect(second.body.data.status).toBe("funded");
    const row = await db.query(
      "SELECT status, status_reason, committed_amount FROM superagent_triggers WHERE id=$1",
      [trigger.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "completed",
      status_reason: "Spending cap reached.",
    });
    expect(Number(row.rows[0].committed_amount)).toBe(8);
    const third = await deliver(trigger, "pull_request", pullRequest(3, sha(3))).expect(202);
    expect(third.body.data.reason).toBe("trigger_completed");
  });

  test("unsigned, mis-signed, foreign, and irrelevant events never open jobs", async () => {
    const { trigger } = await setup();
    await deliver(
      trigger,
      "pull_request",
      pullRequest(1, sha(1)),
      undefined,
      "wrong-secret",
    ).expect(401);
    await api()
      .post(`/v1/github/hooks/${trigger.id}`)
      .set({
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "x",
      })
      .send("{}")
      .expect(401);
    await api().post(`/v1/github/hooks/${crypto.randomUUID()}`).send("{}").expect(404);
    await api().post("/v1/github/hooks/not-a-uuid").send("{}").expect(404);
    expect(
      (
        await deliver(trigger, "pull_request", {
          ...pullRequest(1, sha(1)),
          repository: { full_name: "evil/repo", private: false },
        }).expect(422)
      ).body.error.code,
    ).toBe("repository_mismatch");
    const ignored = async (payload: object, event = "pull_request") =>
      (await deliver(trigger, event, payload).expect(202)).body.data.reason;
    expect(await ignored({ ...pullRequest(1, sha(1)), action: "closed" })).toBe("action_closed");
    expect(await ignored(pullRequest(1, sha(1), { draft: true }))).toBe("draft");
    expect(await ignored(pullRequest(1, sha(1), { base: { ref: "dev" } }))).toBe("other_branch");
    expect(await ignored({ repository: { full_name: "acme/shop" } }, "push")).toBe("event_push");
    const secret = await deliver(trigger, "pull_request", {
      ...pullRequest(1, sha(1)),
      repository: { full_name: "acme/shop", private: true },
    }).expect(202);
    expect(secret.body.data).toMatchObject({
      status: "failed",
      detail: "Private repositories are not supported yet.",
    });
    const jobs = await db.query("SELECT count(*)::int AS count FROM jobs");
    expect(jobs.rows[0].count).toBe(0);
  });

  test("only the owner manages a trigger; pausing stops reviews", async () => {
    const { owner, client, stranger, agentId, trigger } = await setup();
    await api().get(`/v1/super-agents/triggers/${trigger.id}`).set(bearer(stranger)).expect(404);
    await api()
      .post(`/v1/super-agents/triggers/${trigger.id}/pause`)
      .set(bearer(stranger))
      .expect(404);
    await api()
      .post("/v1/super-agents/triggers")
      .set(bearer(owner))
      .send({ agentId, repository: "acme/shop", budgetAmount: 4, spendCap: 10 })
      .expect(422);
    await api()
      .post("/v1/super-agents/triggers")
      .set(bearer(client))
      .send({ agentId, repository: "not a repo", budgetAmount: 4, spendCap: 10 })
      .expect(400);
    await api()
      .post("/v1/super-agents/triggers")
      .set(bearer(client))
      .send({ agentId, repository: "../evil", budgetAmount: 4, spendCap: 10 })
      .expect(400);
    await api()
      .post(`/v1/super-agents/triggers/${trigger.id}/pause`)
      .set(bearer(client))
      .expect(200);
    const paused = await deliver(trigger, "pull_request", pullRequest(1, sha(1))).expect(202);
    expect(paused.body.data.reason).toBe("trigger_paused");
    await api()
      .post(`/v1/super-agents/triggers/${trigger.id}/resume`)
      .set(bearer(client))
      .expect(200);
    await api().delete(`/v1/super-agents/triggers/${trigger.id}`).set(bearer(client)).expect(200);
    await api()
      .post(`/v1/super-agents/triggers/${trigger.id}/resume`)
      .set(bearer(client))
      .expect(409);
  });
});
