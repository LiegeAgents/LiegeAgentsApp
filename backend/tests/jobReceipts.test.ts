import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { encryptPayload, payloadContext, payloadDigest } from "../src/crypto.js";
import {
  ANCHOR_PREFIX,
  anchorData,
  anchorReceipts,
  canonicalJson,
  leafHash,
  merkleTree,
  useReceiptAnchor,
  verifyProof,
} from "../src/jobReceipts.js";

const leaf = (n: number) => `0x${createHash("sha256").update(String(n)).digest("hex")}`;

describe("receipt Merkle trees", () => {
  test("every leaf proves into the root, for any batch size", () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: size }, (_, i) => leaf(i));
      const { root, proofs } = merkleTree(leaves);
      leaves.forEach((value, i) => expect(verifyProof(value, proofs[i], root)).toBe(true));
      // A different leaf, or a tampered proof, does not.
      expect(verifyProof(leaf(99), proofs[0], root)).toBe(false);
      if (proofs[0].length)
        expect(verifyProof(leaves[0], [leaf(98), ...proofs[0].slice(1)], root)).toBe(false);
    }
    expect(merkleTree([leaf(1)]).root).toBe(leaf(1));
  });

  test("leaves hash canonical JSON with sorted keys, and the anchor carries the root", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, "x"], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,"x"]},"b":1}',
    );
    expect(leafHash({ b: 1, a: 2 })).toBe(leafHash({ a: 2, b: 1 }));
    const root = leaf(7);
    expect(anchorData(root)).toBe(
      `0x${Buffer.from(ANCHOR_PREFIX).toString("hex")}${root.slice(2)}`,
    );
  });
});

describe.skipIf(!databaseAvailable)("onchain receipts", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);
  afterEach(() => useReceiptAnchor(undefined));

  /** A fake chain: records what was sent and confirms on demand. */
  function chain() {
    const sent: string[] = [];
    let mined = false;
    let fail = false;
    useReceiptAnchor({
      address: "0x00000000000000000000000000000000000000aa",
      async send(data) {
        if (fail) throw new Error("insufficient funds for gas");
        sent.push(data);
        return `0x${String(sent.length).padStart(64, "0")}`;
      },
      async confirm() {
        return mined ? { status: "success", blockNumber: 1234n } : null;
      },
    });
    return {
      sent,
      mine: () => (mined = true),
      failNext: (value: boolean) => (fail = value),
    };
  }

  async function settle(
    jobId: string,
    providerId: string,
    deliverable: string,
    status = "completed",
  ) {
    await db.query(
      `UPDATE jobs SET status=$2::job_status, funded_at=now() - interval '2 hours',
         submitted_at=now() - interval '1 hour', settled_at=now() WHERE id=$1`,
      [jobId, status],
    );
    await db.query(
      `INSERT INTO submissions (job_id, provider_id, deliverable_ciphertext, deliverable_hash)
       VALUES ($1,$2,$3,$4)`,
      [
        jobId,
        providerId,
        encryptPayload(deliverable, payloadContext(jobId, "deliverable")),
        payloadDigest(deliverable),
      ],
    );
  }

  test("settled jobs are anchored in one batch, and each party can verify its receipt", async () => {
    const [owner, client, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const jobs = await Promise.all([1, 2, 3].map(() => createJob(client, agentId, 5)));
    const open = await createJob(client, agentId, 5);
    await settle(jobs[0], owner.userId, "Five competitors, with sources.");
    await settle(jobs[1], owner.userId, "A second report.");
    await settle(jobs[2], owner.userId, "Not what was asked.", "rejected");
    const fake = chain();

    const run = await anchorReceipts();
    expect(run).toMatchObject({ status: "anchored", created: 3, receipts: 3 });
    expect(fake.sent).toHaveLength(1);
    // Nothing new to anchor; the earlier batch is not resent.
    expect(await anchorReceipts()).toMatchObject({ status: "idle", created: 0 });
    expect(fake.sent).toHaveLength(1);

    const receipt = (await api().get(`/v1/jobs/${jobs[0]}/receipt`).set(bearer(client)).expect(200))
      .body.data;
    expect(receipt.receipt).toMatchObject({
      v: 1,
      chainId: 4663,
      jobId: jobs[0],
      agentId,
      outcome: "completed",
      asset: "usdg",
      budget: "5",
      deliverableSha256: `0x${createHash("sha256").update("Five competitors, with sources.").digest("hex")}`,
    });
    expect(receipt.anchor).toMatchObject({
      status: "sent",
      chainId: 4663,
      txHash: `0x${"1".padStart(64, "0")}`,
    });
    // Verifying needs only the receipt, the proof, and the transaction input.
    expect(receipt.leaf).toBe(leafHash(receipt.receipt));
    expect(verifyProof(receipt.leaf, receipt.proof, receipt.anchor.merkleRoot)).toBe(true);
    expect(fake.sent[0]).toBe(anchorData(receipt.anchor.merkleRoot));

    // The provider sees the same receipt; outsiders and unsettled jobs get nothing.
    const provider = (await api().get(`/v1/jobs/${jobs[2]}/receipt`).set(bearer(owner)).expect(200))
      .body.data;
    expect(provider.receipt.outcome).toBe("rejected");
    expect(verifyProof(provider.leaf, provider.proof, receipt.anchor.merkleRoot)).toBe(true);
    await api().get(`/v1/jobs/${jobs[0]}/receipt`).set(bearer(stranger)).expect(404);
    expect(
      (await api().get(`/v1/jobs/${open}/receipt`).set(bearer(client)).expect(404)).body.error.code,
    ).toBe("receipt_not_ready");

    fake.mine();
    expect(await anchorReceipts()).toMatchObject({ status: "idle", confirmed: 1 });
    const anchor = (await api().get(`/v1/receipt-anchors/${receipt.anchor.batchId}`).expect(200))
      .body.data;
    expect(anchor).toMatchObject({
      merkleRoot: receipt.anchor.merkleRoot,
      receipts: 3,
      status: "confirmed",
      blockNumber: 1234,
      data: fake.sent[0],
    });
    expect(JSON.stringify(anchor)).not.toContain(jobs[0]);
  });

  test("without an anchor wallet receipts wait, and a failed send is retried", async () => {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const jobId = await createJob(client, agentId, 5);
    await settle(jobId, owner.userId, "Done.");

    useReceiptAnchor(null);
    expect(await anchorReceipts()).toMatchObject({ status: "disabled", created: 1 });
    const waiting = (await api().get(`/v1/jobs/${jobId}/receipt`).set(bearer(client)).expect(200))
      .body.data;
    expect(waiting).toMatchObject({ anchor: null, proof: null });

    const fake = chain();
    fake.failNext(true);
    expect(await anchorReceipts()).toMatchObject({ status: "failed" });
    const failed = await db.query("SELECT status, error FROM receipt_batches");
    expect(failed.rows[0]).toMatchObject({ status: "failed", error: "insufficient funds for gas" });
    fake.failNext(false);
    // The batch carries the receipt and the agent's reputation snapshot after it.
    expect(await anchorReceipts()).toMatchObject({
      status: "anchored",
      receipts: 1,
      snapshots: 1,
    });
    const done = (await api().get(`/v1/jobs/${jobId}/receipt`).set(bearer(client)).expect(200)).body
      .data;
    expect(done.proof).toHaveLength(1);
    expect(verifyProof(done.leaf, done.proof, done.anchor.merkleRoot)).toBe(true);
  });

  test("each changed agent's reputation snapshot is anchored with the receipts and can be checked", async () => {
    const [owner, other, client] = await Promise.all([signIn(), signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const idle = await createAgent(other);
    const slug = async (id: string) =>
      (await db.query<{ slug: string }>("SELECT slug FROM agents WHERE id=$1", [id])).rows[0].slug;
    const jobs = await Promise.all([1, 2, 3].map(() => createJob(client, agentId, 5)));
    await settle(jobs[0], owner.userId, "One.");
    await settle(jobs[1], owner.userId, "Two.");
    await settle(jobs[2], owner.userId, "Three.", "rejected");

    // Without an anchor wallet nothing is snapshotted, so nothing piles up.
    useReceiptAnchor(null);
    await anchorReceipts();
    await api()
      .get(`/v1/agents/${await slug(agentId)}/reputation-proof`)
      .expect(404);

    const fake = chain();
    expect(await anchorReceipts()).toMatchObject({ status: "anchored", receipts: 3, snapshots: 1 });
    const first = (
      await api()
        .get(`/v1/agents/${await slug(agentId)}/reputation-proof`)
        .expect(200)
    ).body.data;
    expect(first.snapshot).toMatchObject({
      v: 1,
      kind: "reputation",
      chainId: 4663,
      agentId,
      outcomes: {
        completed: 2,
        rejected: 1,
        undelivered: 0,
        onTime: 2,
        completedWithRevision: 0,
        disputesLost: 0,
      },
      // Three outcomes: not scored until five.
      score: null,
      method: { minimumOutcomes: 5 },
    });
    expect(first.leaf).toBe(leafHash(first.snapshot));
    expect(verifyProof(first.leaf, first.proof, first.anchor.merkleRoot)).toBe(true);
    expect(first.anchor).toMatchObject({ status: "sent", txHash: `0x${"1".padStart(64, "0")}` });
    const batch = (await api().get(`/v1/receipt-anchors/${first.anchor.batchId}`).expect(200)).body
      .data;
    expect(batch).toMatchObject({ receipts: 3, reputationSnapshots: 1 });
    // An agent with nothing recorded has nothing to prove.
    expect(
      (
        await api()
          .get(`/v1/agents/${await slug(idle)}/reputation-proof`)
          .expect(404)
      ).body.error.code,
    ).toBe("reputation_not_anchored");

    // No change, no new snapshot; a new outcome gets one in the next batch.
    expect(await anchorReceipts()).toMatchObject({ status: "idle" });
    const later = await createJob(client, agentId, 5);
    await settle(later, owner.userId, "Four.");
    fake.mine();
    expect(await anchorReceipts()).toMatchObject({ status: "anchored", receipts: 1, snapshots: 1 });
    const second = (
      await api()
        .get(`/v1/agents/${await slug(agentId)}/reputation-proof`)
        .expect(200)
    ).body.data;
    expect(second.snapshot.outcomes.completed).toBe(3);
    expect(second.anchor.batchId).not.toBe(first.anchor.batchId);
    expect(verifyProof(second.leaf, second.proof, second.anchor.merkleRoot)).toBe(true);
    expect(fake.sent).toHaveLength(2);
  });
});
