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
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { MAX_FILE_BYTES, verifiedMediaType } from "../src/routes/jobAttachments.js";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("declared file types must match the file's contents", () => {
  expect(verifiedMediaType("application/pdf", pdf)).toBe("application/pdf");
  expect(verifiedMediaType("image/png", pdf)).toBeNull();
  expect(verifiedMediaType("image/png", png)).toBe("image/png");
  expect(verifiedMediaType("text/markdown; charset=utf-8", Buffer.from("# Notes"))).toBe(
    "text/markdown",
  );
  expect(verifiedMediaType("text/plain", Buffer.from([0x66, 0x00, 0x6f]))).toBeNull();
  expect(verifiedMediaType("text/plain", Buffer.from([0xc3, 0x28]))).toBeNull();
  expect(verifiedMediaType("application/x-msdownload", Buffer.from("MZ"))).toBeNull();
});

describe.skipIf(!databaseAvailable)("job attachments", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function openJob() {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    await credit(client.userId, 100);
    const jobId = await createJob(client, agentId, 10);
    return { owner, client, stranger, agentId, jobId };
  }

  const upload = (token: string, jobId: string, name: string, type: string, body: Buffer) =>
    api()
      .post(`/v1/jobs/${jobId}/attachments/file`)
      .query({ name })
      .set({ Authorization: `Bearer ${token}`, "Content-Type": type })
      .send(body);

  const link = (token: string, jobId: string, body: object) =>
    api()
      .post(`/v1/jobs/${jobId}/attachments`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body);

  test("the client attaches files and links; parties read them back decrypted", async () => {
    const { owner, client, jobId } = await openJob();
    const file = await upload(
      client.token,
      jobId,
      "specs/brief.pdf",
      "application/pdf",
      pdf,
    ).expect(201);
    expect(file.body.data).toMatchObject({
      kind: "file",
      name: "brief.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
    });
    const repo = await link(client.token, jobId, {
      url: "https://github.com/liegeagents/liegeagentsapp",
      commit: "D3EFA0B",
    }).expect(201);
    expect(repo.body.data).toMatchObject({
      kind: "link",
      name: "https://github.com/liegeagents/liegeagentsapp@d3efa0b",
    });

    const list = await api().get(`/v1/jobs/${jobId}/attachments`).set(bearer(owner)).expect(200);
    expect(list.body.data.map((item: { name: string }) => item.name)).toEqual([
      "brief.pdf",
      "https://github.com/liegeagents/liegeagentsapp@d3efa0b",
    ]);
    const content = await api()
      .get(`/v1/jobs/${jobId}/attachments/${file.body.data.id}`)
      .set(bearer(owner))
      .expect(200);
    expect(Buffer.from(content.body.data.data, "base64").equals(pdf)).toBe(true);
    const linked = await api()
      .get(`/v1/jobs/${jobId}/attachments/${repo.body.data.id}`)
      .set(bearer(client))
      .expect(200);
    expect(linked.body.data).toMatchObject({
      url: "https://github.com/liegeagents/liegeagentsapp",
      commit: "d3efa0b",
    });

    // Stored encrypted: neither the name nor the contents appear in the row.
    const row = await db.query(
      "SELECT name_ciphertext, content_ciphertext FROM job_attachments WHERE id = $1",
      [repo.body.data.id],
    );
    expect(row.rows[0].name_ciphertext).not.toContain("github");
    expect(row.rows[0].content_ciphertext).not.toContain("github");
  });

  test("only the client adds or removes, only before funding, and only parties read", async () => {
    const { owner, client, stranger, jobId } = await openJob();
    expect(
      (await link(owner.token, jobId, { url: "https://example.com" }).expect(403)).body.error.code,
    ).toBe("not_client");
    await link(stranger.token, jobId, { url: "https://example.com" }).expect(404);
    await link(client.token, jobId, { url: "http://example.com" }).expect(400);
    await link(client.token, jobId, { url: "https://user:pass@example.com" }).expect(400);
    await link(client.token, jobId, { url: "https://example.com", commit: "main" }).expect(400);
    await api().get(`/v1/jobs/${jobId}/attachments`).set(bearer(stranger)).expect(404);

    const added = await link(client.token, jobId, { url: "https://example.com/spec" }).expect(201);
    await api()
      .delete(`/v1/jobs/${jobId}/attachments/${added.body.data.id}`)
      .set(bearer(owner))
      .expect(403);
    await api()
      .delete(`/v1/jobs/${jobId}/attachments/${added.body.data.id}`)
      .set(bearer(client))
      .expect(204);
    const kept = await link(client.token, jobId, { url: "https://example.com/final" }).expect(201);

    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    expect(
      (await link(client.token, jobId, { url: "https://example.com/late" }).expect(409)).body.error
        .code,
    ).toBe("attachments_locked");
    await api()
      .delete(`/v1/jobs/${jobId}/attachments/${kept.body.data.id}`)
      .set(bearer(client))
      .expect(409);
  });

  test("files are checked for type, size, and count", async () => {
    const { client, jobId } = await openJob();
    expect(
      (await upload(client.token, jobId, "fake.png", "image/png", pdf).expect(415)).body.error.code,
    ).toBe("unsupported_attachment");
    await upload(
      client.token,
      jobId,
      "run.exe",
      "application/octet-stream",
      Buffer.from("MZ"),
    ).expect(415);
    await upload(client.token, jobId, "empty.txt", "text/plain", Buffer.alloc(0)).expect(400);
    await upload(client.token, jobId, "bad\u0007.txt", "text/plain", Buffer.from("x")).expect(400);
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
    expect(
      (await upload(client.token, jobId, "big.txt", "text/plain", big).expect(413)).body.error.code,
    ).toBe("payload_too_large");
    for (let index = 0; index < 5; index++)
      await upload(
        client.token,
        jobId,
        `note-${index}.md`,
        "text/markdown",
        Buffer.from("# Hi"),
      ).expect(201);
    expect(
      (await link(client.token, jobId, { url: "https://example.com" }).expect(409)).body.error.code,
    ).toBe("attachment_limit");
  });

  test("a Super Agent runtime reads its own job's attachments but cannot add them", async () => {
    const { owner, client, agentId, jobId } = await openJob();
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "code-review",
          name: "Code review",
          description: "A focused code review.",
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
    const runtime = (
      await api().post("/v1/super-agents/runtime-token").set(bearer(owner)).expect(201)
    ).body.data.token;
    const asRuntime = { Authorization: `Bearer ${runtime}`, "x-liege-runtime-token": "1" };
    const added = await upload(
      client.token,
      jobId,
      "notes.txt",
      "text/plain",
      Buffer.from("Hi"),
    ).expect(201);
    await api()
      .post(`/v1/jobs/${jobId}/attachments`)
      .set(asRuntime)
      .send({ url: "https://example.com" })
      .expect(403);
    const list = await api().get(`/v1/jobs/${jobId}/attachments`).set(asRuntime).expect(200);
    expect(list.body.data).toHaveLength(1);
    const content = await api()
      .get(`/v1/jobs/${jobId}/attachments/${added.body.data.id}`)
      .set(asRuntime)
      .expect(200);
    expect(Buffer.from(content.body.data.data, "base64").toString()).toBe("Hi");
  });
});
