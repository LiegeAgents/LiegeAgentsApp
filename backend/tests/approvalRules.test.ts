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
  openJob,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { checkRule, checkRules } from "../src/approvalRules.js";
import { ensureEscrowWallet } from "../src/escrow.js";
import { processSettlement, useEscrowChain } from "../src/settlement.js";
import { FakeChain } from "./fake-chain.js";

describe("approval rule checks", () => {
  const report = "# Summary\nRevenue grew 12% on strong demand.\n\n## Sources\nSee links.";

  test("word counts, required text, and headings", () => {
    expect(checkRule({ type: "min_words", value: 10 }, report, []).passed).toBe(true);
    expect(checkRule({ type: "min_words", value: 50 }, report, []).detail).toBe(
      "10 words; needs at least 50.",
    );
    expect(checkRule({ type: "max_words", value: 5 }, report, []).passed).toBe(false);
    expect(checkRule({ type: "contains", value: "REVENUE GREW" }, report, []).passed).toBe(true);
    expect(checkRule({ type: "heading", value: "Sources" }, report, []).passed).toBe(true);
    // A heading must be a heading, not a mention.
    expect(checkRule({ type: "heading", value: "links" }, report, []).passed).toBe(false);
    expect(checkRule({ type: "heading", value: "Sum.ary" }, report, []).passed).toBe(false);
  });

  test("JSON shape and evidence links", () => {
    expect(checkRule({ type: "json", keys: [] }, report, []).detail).toBe("Not valid JSON.");
    const json = JSON.stringify({ ticker: "HOOD", price: 52 });
    expect(checkRule({ type: "json", keys: ["ticker", "price"] }, json, []).passed).toBe(true);
    expect(checkRule({ type: "json", keys: ["ticker", "volume"] }, json, []).detail).toBe(
      "Missing keys: volume.",
    );
    expect(checkRule({ type: "json", keys: ["a"] }, "[1,2]", []).passed).toBe(false);
    expect(checkRule({ type: "min_links", value: 2 }, report, ["https://a.example"]).passed).toBe(
      false,
    );
    const all = checkRules(
      [
        { type: "min_words", value: 5 },
        { type: "heading", value: "Summary" },
      ],
      report,
      [],
    );
    expect(all.passed).toBe(true);
    expect(all.results).toHaveLength(2);
  });
});

describe.skipIf(!databaseAvailable)("rule-based approval", () => {
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

  const rules = [
    { type: "min_words", value: 5 },
    { type: "heading", value: "Summary" },
    { type: "min_links", value: 1 },
  ];
  async function delivered(
    deliverable: string,
    extra: object = {},
    evidence = ["https://example.com/a"],
  ) {
    const jobId = (
      await openJob(client, agentId, 10, { approvalRules: rules, ...extra }).expect(201)
    ).body.data.id;
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    return (
      await api()
        .post(`/v1/jobs/${jobId}/submit`)
        .set(bearer(provider))
        .send({ deliverable, evidence })
        .expect(200)
    ).body.data;
  }
  const passing = "# Summary\nMarkets rose on strong earnings this week.";

  test("a delivery that passes every rule is accepted and paid without review", async () => {
    const job = await delivered(passing);
    expect(job.status).toBe("completed");
    expect(job.ruleCheck.passed).toBe(true);
    expect(await availableBalance(provider.userId)).toBe(10);
    const detail = (await api().get(`/v1/jobs/${job.id}`).set(bearer(client)).expect(200)).body
      .data;
    expect(detail.submission.ruleCheck.results).toHaveLength(3);
    expect(detail.evaluation.outcome).toBe("accepted");
    expect(detail.evaluation.rationale).toContain("all 3 approval rules passed");
  });

  test("a failed rule leaves the delivery for the client to review", async () => {
    const job = await delivered("Markets rose.", {}, []);
    expect(job.status).toBe("submitted");
    expect(job.ruleCheck.passed).toBe(false);
    expect(job.ruleCheck.results.filter((item: { passed: boolean }) => !item.passed)).toHaveLength(
      3,
    );
    expect(await availableBalance(provider.userId)).toBe(0);
  });

  test("an automatic acceptance still waits out the challenge window", async () => {
    const job = await delivered(passing, { challengeWindowHours: 24 });
    expect(job.status).toBe("completed");
    expect(job.settled_at).toBeNull();
    expect(job.payout_due_at).not.toBeNull();
    expect(await availableBalance(provider.userId)).toBe(0);
  });

  test("rules are checked on every delivery, including a revision", async () => {
    const first = await delivered("Too short.", {}, []);
    expect(first.status).toBe("submitted");
    await api()
      .post(`/v1/jobs/${first.id}/revision`)
      .set(bearer(client))
      .send({ feedback: "Add a Summary heading and a source." })
      .expect(200);
    const revised = (
      await api()
        .post(`/v1/jobs/${first.id}/submit`)
        .set(bearer(provider))
        .send({ deliverable: passing, evidence: ["https://example.com/b"] })
        .expect(200)
    ).body.data;
    expect(revised.status).toBe("completed");
  });

  test("invalid rules are refused when the job is opened", async () => {
    await openJob(client, agentId, 10, { approvalRules: [{ type: "vibes", value: 1 }] }).expect(
      400,
    );
    await openJob(client, agentId, 10, { approvalRules: [] }).expect(400);
    const row = await db.query("SELECT count(*)::int AS n FROM jobs");
    expect(row.rows[0].n).toBe(0);
  });

  test("on Liege onchain escrow, passing every rule plans the escrow's payout", async () => {
    useEscrowChain(new FakeChain());
    const jobId = (await openJob(client, agentId, 10, { approvalRules: rules }).expect(201)).body
      .data.id;
    await db.query("UPDATE jobs SET escrow_mode = 'onchain', status = 'funded' WHERE id = $1", [
      jobId,
    ]);
    await ensureEscrowWallet(db, jobId);
    const job = (
      await api()
        .post(`/v1/jobs/${jobId}/submit`)
        .set(bearer(provider))
        .send({ deliverable: passing, evidence: ["https://example.com/a"] })
        .expect(200)
    ).body.data;
    expect(job.status).toBe("completed");
    const plan = await db.query("SELECT outcome FROM escrow_settlements WHERE job_id = $1", [
      jobId,
    ]);
    expect(plan.rows[0].outcome).toBe("accepted");
    // Let the background settlement finish before the data is cleared.
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await processSettlement(jobId);
      if (status === "complete" || status === "failed") break;
      await Bun.sleep(10);
    }
  });
});
