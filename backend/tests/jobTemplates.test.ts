import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db/index.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  databaseAvailable,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("job templates", () => {
  let client: User;
  let agentId: string;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    client = await signIn();
    agentId = await createAgent(await signIn());
  });

  const save = (user: User, body: Record<string, unknown>) =>
    api().post("/v1/job-templates").set(bearer(user)).send(body);
  const weekly = {
    name: "Weekly market summary",
    title: "Summarize this week's market moves",
    brief: "Cover the five largest moves and link every source.",
    acceptanceCriteria: ["Five moves covered", "Every claim sourced"],
    approvalRules: [{ type: "min_links", value: 5 }],
    settlementAsset: "usdg",
    budget: 12.5,
  };

  test("saves, lists with the brief decrypted, replaces by name, and deletes", async () => {
    const created = (await save(client, { ...weekly, agentId }).expect(201)).body.data;
    expect(created).toMatchObject({
      name: weekly.name,
      brief: weekly.brief,
      acceptanceCriteria: weekly.acceptanceCriteria,
      approvalRules: weekly.approvalRules,
      agentId,
      budget: "12.5",
    });
    expect(created.agentName).toBeTruthy();

    // The brief is stored encrypted.
    const stored = await db.query<{ brief_ciphertext: string }>(
      "SELECT brief_ciphertext FROM job_templates WHERE id = $1",
      [created.id],
    );
    expect(stored.rows[0].brief_ciphertext).not.toContain("five largest moves");

    const replaced = (
      await save(client, { ...weekly, brief: "Cover the ten largest moves." }).expect(200)
    ).body.data;
    expect(replaced.id).toBe(created.id);
    expect(replaced).toMatchObject({ brief: "Cover the ten largest moves.", agentId: null });

    await save(client, { ...weekly, name: "Second" }).expect(201);
    const list = (await api().get("/v1/job-templates").set(bearer(client)).expect(200)).body.data;
    expect(list.map((t: { name: string }) => t.name)).toEqual(["Second", weekly.name]);

    await api().delete(`/v1/job-templates/${created.id}`).set(bearer(client)).expect(204);
    await api().delete(`/v1/job-templates/${created.id}`).set(bearer(client)).expect(404);
    expect(
      (await api().get("/v1/job-templates").set(bearer(client)).expect(200)).body.data,
    ).toHaveLength(1);
  });

  test("templates stay private to their owner", async () => {
    const created = (await save(client, weekly).expect(201)).body.data;
    const other = await signIn();
    expect((await api().get("/v1/job-templates").set(bearer(other)).expect(200)).body.data).toEqual(
      [],
    );
    await api().delete(`/v1/job-templates/${created.id}`).set(bearer(other)).expect(404);
    // The same name is free for another account.
    await save(other, weekly).expect(201);
    await save(client, { ...weekly, agentId: "00000000-0000-4000-8000-000000000000" }).expect(404);
    await save(client, { ...weekly, acceptanceCriteria: [] }).expect(400);
  });
});
