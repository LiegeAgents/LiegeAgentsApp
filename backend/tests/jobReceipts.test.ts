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
    expect(await anchorReceipts()).toMatchObject({ status: "anchored", receipts: 1 });
    // A one-receipt batch's root is the leaf itself.
    const done = (await api().get(`/v1/jobs/${jobId}/receipt`).set(bearer(client)).expect(200)).body
      .data;
    expect(done.anchor.merkleRoot).toBe(done.leaf);
    expect(done.proof).toEqual([]);
  });
});
