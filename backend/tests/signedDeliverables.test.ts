import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
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
import { createPendingReceipts } from "../src/jobReceipts.js";
import {
  keyFingerprint,
  sha256Hex,
  signedMessage,
  verifyDeliverableSignature,
} from "../src/deliverableSignatures.js";

/** A fresh Ed25519 key pair, the public half as base64 raw bytes, like an agent runtime makes. */
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKey: Buffer.from(raw).toString("base64"),
    sign: (jobId: string, deliverable: string) =>
      sign(
        null,
        Buffer.from(signedMessage(jobId, sha256Hex(deliverable)), "utf8"),
        privateKey,
      ).toString("base64"),
  };
}

describe("deliverable signatures", () => {
  test("verify only the exact deliverable, job, and key that were signed", () => {
    const key = keyPair();
    const other = keyPair();
    const jobId = crypto.randomUUID();
    const signature = key.sign(jobId, "# Report");
    expect(verifyDeliverableSignature(key.publicKey, signature, jobId, "# Report")).toBe(true);
    expect(verifyDeliverableSignature(key.publicKey, signature, jobId, "# Report!")).toBe(false);
    expect(
      verifyDeliverableSignature(key.publicKey, signature, crypto.randomUUID(), "# Report"),
    ).toBe(false);
    expect(verifyDeliverableSignature(other.publicKey, signature, jobId, "# Report")).toBe(false);
    expect(verifyDeliverableSignature("not-a-key", signature, jobId, "# Report")).toBe(false);
    expect(keyFingerprint(key.publicKey)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe.skipIf(!databaseAvailable)("signed deliverables", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function fundedJob() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    await credit(client.userId, 20);
    const jobId = await createJob(client, agentId, 5);
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
    const slug = (
      await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id=$1", [agentId])
    ).rows[0].slug;
    return { owner, client, agentId, jobId, slug };
  }

  test("an agent publishes its key, signs its delivery, and the receipt carries the proof", async () => {
    const { owner, client, agentId, jobId, slug } = await fundedJob();
    const key = keyPair();
    const deliverable = "# Market summary\n\nThree moves this week.";

    // Not published yet: nothing to check a signature against.
    expect((await api().get(`/v1/agents/${slug}/signing-key`).expect(404)).body.error.code).toBe(
      "signing_key_not_set",
    );
    expect(
      (
        await api()
          .post(`/v1/jobs/${jobId}/submit`)
          .set(bearer(owner))
          .send({ deliverable, signature: key.sign(jobId, deliverable) })
          .expect(422)
      ).body.error.code,
    ).toBe("signing_key_not_set");

    // Only the owner can publish, and only a real Ed25519 key.
    await api()
      .put(`/v1/agents/${agentId}/signing-key`)
      .set(bearer(client))
      .send({ publicKey: key.publicKey })
      .expect(404);
    await api()
      .put(`/v1/agents/${agentId}/signing-key`)
      .set(bearer(owner))
      .send({ publicKey: "AAAA" })
      .expect(422);
    await api()
      .put(`/v1/agents/${agentId}/signing-key`)
      .set(bearer(owner))
      .send({ publicKey: key.publicKey })
      .expect(200);
    const published = (await api().get(`/v1/agents/${slug}/signing-key`).expect(200)).body.data;
    expect(published).toMatchObject({
      algorithm: "Ed25519",
      publicKey: key.publicKey,
      fingerprint: keyFingerprint(key.publicKey),
    });

    // A signature over different text is refused; the right one is kept.
    expect(
      (
        await api()
          .post(`/v1/jobs/${jobId}/submit`)
          .set(bearer(owner))
          .send({ deliverable, signature: key.sign(jobId, "something else") })
          .expect(422)
      ).body.error.code,
    ).toBe("invalid_deliverable_signature");
    const signature = key.sign(jobId, deliverable);
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable, signature })
      .expect(200);

    await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "Good." })
      .expect(200);
    await createPendingReceipts();
    const receipt = (
      await db.query<{ receipt: Record<string, unknown> }>(
        "SELECT receipt FROM job_receipts WHERE job_id=$1",
        [jobId],
      )
    ).rows[0].receipt;
    expect(receipt).toMatchObject({
      jobId,
      deliverableSha256: sha256Hex(deliverable),
      deliverableSignature: { algorithm: "Ed25519", publicKey: key.publicKey, signature },
    });
    // Anyone holding the receipt can check it without Liege.
    expect(verifyDeliverableSignature(key.publicKey, signature, jobId, deliverable)).toBe(true);
  });

  test("unsigned deliveries still work and their receipts carry no signature", async () => {
    const { owner, client, jobId } = await fundedJob();
    await api()
      .post(`/v1/jobs/${jobId}/submit`)
      .set(bearer(owner))
      .send({ deliverable: "# Report" })
      .expect(200);
    await api()
      .post(`/v1/jobs/${jobId}/evaluate`)
      .set(bearer(client))
      .send({ outcome: "accepted", rationale: "Good." })
      .expect(200);
    await createPendingReceipts();
    const receipt = (
      await db.query<{ receipt: Record<string, unknown> }>(
        "SELECT receipt FROM job_receipts WHERE job_id=$1",
        [jobId],
      )
    ).rows[0].receipt;
    expect(receipt.deliverableSignature).toBeUndefined();
  });
});
