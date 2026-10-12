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
import { stepBrief } from "../src/superAgentSquads.js";

type User = Awaited<ReturnType<typeof signIn>>;

test("each step's brief carries the request, the plan, and its own part", () => {
  const brief = stepBrief({
    request: "Launch plan for my note-taking app",
    steps: [
      { agentName: "Anna", task: "Research the market" },
      { agentName: "Daniel", task: "Turn it into a launch plan" },
    ],
    position: 1,
  });
  expect(brief).toContain("step 2 of 2");
  expect(brief).toContain("Launch plan for my note-taking app");
  expect(brief).toContain("2. Daniel: Turn it into a launch plan  <- you");
  expect(brief).toContain("earlier steps are attached");
});

describe.skipIf(!databaseAvailable)("Super Agent squads", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function superAgent(owner: User, name: string) {
    const agentId = await createAgent(owner);
    await db.query("UPDATE agents SET name=$2 WHERE id=$1", [agentId, name]);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: `svc-${crypto.randomUUID().slice(0, 8)}`,
          name: `${name} service`,
          description: `${name} delivers focused, well-organized work.`,
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
    return agentId;
  }

  async function crew() {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const anna = await superAgent(owner, "Anna");
    const daniel = await superAgent(owner, "Daniel");
    const scott = await superAgent(owner, "Scott");
    return { owner, client, stranger, anna, daniel, scott };
  }

  const create = (user: User, body: object) =>
    api().post("/v1/super-agents/squads").set(bearer(user)).send(body);
  const squadView = async (user: User, id: string) =>
    (await api().get(`/v1/super-agents/squads/${id}`).set(bearer(user)).expect(200)).body.data;
  const submit = (owner: User, jobId: string, deliverable: string) =>
    api().post(`/v1/jobs/${jobId}/submit`).set(bearer(owner)).send({ deliverable }).expect(200);

  test("one approval runs the crew in order, each step building on the last", async () => {
    const { owner, client, anna, daniel, scott } = await crew();
    await credit(client.userId, 100);
    const created = await create(client, {
      name: "Launch my app",
      request: "Launch plan for my note-taking app",
      autoFund: true,
      steps: [
        { agentId: anna, task: "Research the market", budgetAmount: 2 },
        { agentId: daniel, task: "Turn it into a launch plan", budgetAmount: 3 },
        { agentId: scott, task: "Write the launch copy", budgetAmount: 4 },
      ],
    }).expect(201);
    const squad = created.body.data;
    expect(squad).toMatchObject({ name: "Launch my app", status: "running" });
    expect(Number(squad.total_budget)).toBe(9);
    expect(squad.steps.map((step: { job_status: string | null }) => step.job_status)).toEqual([
      "funded",
      null,
      null,
    ]);
    // Only the first step is paid for up front.
    expect(await availableBalance(client.userId)).toBe(98);
    const first = squad.steps[0].job_id;
    const firstJob = await db.query("SELECT title, strategy_policy FROM jobs WHERE id=$1", [first]);
    expect(firstJob.rows[0].title).toBe("Squad 1/3 · Anna: Research the market");
    expect(firstJob.rows[0].strategy_policy).toMatchObject({ squadId: squad.id, squadStep: 0 });
    const brief = await api().get(`/v1/jobs/${first}/payload/brief`).set(bearer(owner)).expect(200);
    expect(brief.body.data.content).toContain("1. Anna: Research the market  <- you");

    await submit(owner, first, "Market research: three competitors.");
    let view = await squadView(client, squad.id);
    const second = view.steps[1].job_id;
    expect(view.steps[1].job_status).toBe("funded");
    expect(await availableBalance(client.userId)).toBe(95);
    const attached = await api()
      .get(`/v1/jobs/${second}/attachments`)
      .set(bearer(owner))
      .expect(200);
    expect(attached.body.data.map((item: { name: string }) => item.name)).toEqual([
      "step-1-anna.md",
    ]);
    const handoff = await api()
      .get(`/v1/jobs/${second}/attachments/${attached.body.data[0].id}`)
      .set(bearer(owner))
      .expect(200);
    expect(Buffer.from(handoff.body.data.data, "base64").toString()).toBe(
      "Market research: three competitors.",
    );

    await submit(owner, second, "Launch plan: four weeks.");
    view = await squadView(client, squad.id);
    const third = view.steps[2].job_id;
    const thirdFiles = await api()
      .get(`/v1/jobs/${third}/attachments`)
      .set(bearer(owner))
      .expect(200);
    expect(thirdFiles.body.data.map((item: { name: string }) => item.name)).toEqual([
      "step-1-anna.md",
      "step-2-daniel.md",
    ]);

    await submit(owner, third, "Launch copy.");
    view = await squadView(client, squad.id);
    expect(view.status).toBe("completed");
    // Each step is settled on its own: the client accepts each agent's work.
    for (const step of view.steps)
      await api()
        .post(`/v1/jobs/${step.job_id}/evaluate`)
        .set(bearer(client))
        .send({ outcome: "accepted", rationale: "Good." })
        .expect(200);
    expect(await availableBalance(owner.userId)).toBe(9);
    expect(await availableBalance(client.userId)).toBe(91);
  });

  test("without auto-funding, or without enough balance, a step waits for the client", async () => {
    const { owner, client, anna, daniel } = await crew();
    await credit(client.userId, 3);
    const manual = (
      await create(client, {
        request: "Research then plan",
        steps: [
          { agentId: anna, task: "Research", budgetAmount: 2 },
          { agentId: daniel, task: "Plan", budgetAmount: 2 },
        ],
      }).expect(201)
    ).body.data;
    expect(manual.steps[0]).toMatchObject({ job_status: "open" });
    expect(manual.steps[0].detail).toContain("Auto-funding is off");
    await api()
      .post(`/v1/jobs/${manual.steps[0].job_id}/fund`)
      .set(bearer(client))
      .send({})
      .expect(200);

    const funded = (
      await create(client, {
        request: "Research then plan",
        autoFund: true,
        steps: [
          { agentId: anna, task: "Research", budgetAmount: 1 },
          { agentId: daniel, task: "Plan", budgetAmount: 2 },
        ],
      }).expect(201)
    ).body.data;
    expect(funded.steps[0].job_status).toBe("funded");
    await submit(owner, funded.steps[0].job_id, "Research.");
    const view = await squadView(client, funded.id);
    expect(view.steps[1].job_status).toBe("open");
    expect(view.steps[1].detail).toContain("balance cannot fund");
    expect(view.status).toBe("running");
  });

  test("squads are validated and only their owner sees or cancels them", async () => {
    const { owner, client, stranger, anna, daniel } = await crew();
    await create(client, {
      request: "Solo",
      steps: [{ agentId: anna, task: "Research", budgetAmount: 1 }],
    }).expect(400);
    expect(
      (
        await create(owner, {
          request: "My own agents",
          steps: [
            { agentId: anna, task: "Research", budgetAmount: 1 },
            { agentId: daniel, task: "Plan", budgetAmount: 1 },
          ],
        }).expect(422)
      ).body.error.code,
    ).toBe("self_hire_not_allowed");
    const squad = (
      await create(client, {
        request: "Research then plan",
        steps: [
          { agentId: anna, task: "Research", budgetAmount: 1 },
          { agentId: daniel, task: "Plan", budgetAmount: 1 },
        ],
      }).expect(201)
    ).body.data;
    await api().get(`/v1/super-agents/squads/${squad.id}`).set(bearer(stranger)).expect(404);
    await api()
      .post(`/v1/super-agents/squads/${squad.id}/cancel`)
      .set(bearer(stranger))
      .expect(404);
    const list = await api().get("/v1/super-agents/squads").set(bearer(stranger)).expect(200);
    expect(list.body.data).toEqual([]);

    const cancelled = await api()
      .post(`/v1/super-agents/squads/${squad.id}/cancel`)
      .set(bearer(client))
      .expect(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    // The running step can still deliver, but nothing follows it.
    await credit(client.userId, 10);
    await api()
      .post(`/v1/jobs/${squad.steps[0].job_id}/fund`)
      .set(bearer(client))
      .send({})
      .expect(200);
    await submit(owner, squad.steps[0].job_id, "Research.");
    expect((await squadView(client, squad.id)).steps[1].job_id).toBeNull();
    await api().post(`/v1/super-agents/squads/${squad.id}/cancel`).set(bearer(client)).expect(409);
  });

  test("a step that ends without delivering stops the squad", async () => {
    const { owner, client, anna, daniel } = await crew();
    await credit(client.userId, 10);
    const squad = (
      await create(client, {
        request: "Research then plan",
        autoFund: true,
        steps: [
          { agentId: anna, task: "Research", budgetAmount: 1 },
          { agentId: daniel, task: "Plan", budgetAmount: 1 },
        ],
      }).expect(201)
    ).body.data;
    await api()
      .post(`/v1/jobs/${squad.steps[0].job_id}/decline`)
      .set(bearer(owner))
      .send({ reason: "Out of scope." })
      .expect(200);
    const view = await squadView(client, squad.id);
    expect(view.status).toBe("stopped");
    expect(view.status_reason).toContain("Step 1 (Anna) ended without a delivery");
  });

  test("if the next agent is no longer available, the squad stops with the reason", async () => {
    const { owner, client, anna, daniel } = await crew();
    await credit(client.userId, 10);
    const squad = (
      await create(client, {
        request: "Research then plan",
        autoFund: true,
        steps: [
          { agentId: anna, task: "Research", budgetAmount: 1 },
          { agentId: daniel, task: "Plan", budgetAmount: 1 },
        ],
      }).expect(201)
    ).body.data;
    await db.query("UPDATE superagent_enrollments SET enabled=false WHERE agent_id=$1", [daniel]);
    await submit(owner, squad.steps[0].job_id, "Research.");
    const view = await squadView(client, squad.id);
    expect(view.status).toBe("stopped");
    expect(view.status_reason).toContain("Step 2 (Daniel) could not start");
    expect(await availableBalance(client.userId)).toBe(9);
  });

  test("a runtime token cannot start a squad", async () => {
    const { owner } = await crew();
    const runtime = (
      await api().post("/v1/super-agents/runtime-token").set(bearer(owner)).expect(201)
    ).body.data.token;
    await api()
      .post("/v1/super-agents/squads")
      .set({ Authorization: `Bearer ${runtime}`, "x-liege-runtime-token": "1" })
      .send({ request: "x", steps: [] })
      .expect(403);
  });
});
