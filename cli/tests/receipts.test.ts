import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execute } from "../src/index.js";
import { ANCHOR_PREFIX, canonicalJson, foldProof, receiptLeaf } from "../src/receipts.js";

const receipt = {
  v: 1,
  chainId: 4663,
  jobId: "11111111-1111-4111-8111-111111111111",
  job: "JOB-ABCD1234",
  agentId: "22222222-2222-4222-8222-222222222222",
  outcome: "completed",
  asset: "usdg",
  budget: "5",
  settledAt: "2026-10-20T10:00:00.000Z",
  deliverableSha256: `0x${"ab".repeat(32)}`,
};
const anchorAddress = "0x00000000000000000000000000000000000000aa";
const txHash = `0x${"cd".repeat(32)}`;
const sibling = `0x${createHash("sha256").update("another job").digest("hex")}`;

describe("verifying receipts from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let served: Record<string, unknown> = {};
  let rpcCalls: string[] = [];
  let chainInput = "";

  beforeEach(() => {
    rpcCalls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    const leaf = receiptLeaf(receipt);
    const root = foldProof(leaf, [sibling]);
    chainInput = `0x${Buffer.from(ANCHOR_PREFIX).toString("hex")}${root.slice(2)}`;
    served = {
      receipt,
      leaf,
      proof: [sibling],
      anchor: { status: "confirmed", merkleRoot: root, chainId: 4663, anchorAddress, txHash },
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "rpc.example") {
        const { method } = JSON.parse(String(init?.body));
        rpcCalls.push(method);
        return Response.json({
          result:
            method === "eth_getTransactionByHash"
              ? {
                  hash: txHash,
                  from: anchorAddress,
                  to: anchorAddress,
                  input: chainInput,
                  chainId: "0x1237",
                }
              : { status: "0x1", blockNumber: "0x4d2" },
        });
      }
      return Response.json({ data: served });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("checks the receipt, proof, and transaction itself", async () => {
    const result = (await execute([
      "jobs",
      "receipt",
      "job-1",
      "--rpc",
      "https://rpc.example",
    ])) as {
      verification: {
        verified: boolean;
        status: string;
        checks: Array<{ ok: boolean; detail?: string }>;
      };
    };
    expect(result.verification).toMatchObject({ verified: true, status: "anchored" });
    expect(result.verification.checks).toHaveLength(6);
    expect(result.verification.checks.at(-1)?.detail).toBe("block 1234");
    expect(rpcCalls.sort()).toEqual(["eth_getTransactionByHash", "eth_getTransactionReceipt"]);
  });

  test("an edited receipt or a different transaction fails", async () => {
    served = { ...served, receipt: { ...receipt, budget: "500" } };
    const edited = (await execute([
      "jobs",
      "receipt",
      "job-1",
      "--rpc",
      "https://rpc.example",
    ])) as {
      verification: { verified: boolean; checks: Array<{ check: string; ok: boolean }> };
    };
    expect(edited.verification.verified).toBe(false);
    expect(edited.verification.checks[0]).toMatchObject({
      check: "receipt hashes to its leaf",
      ok: false,
    });

    served = { ...served, receipt };
    chainInput = `0x${"00".repeat(49)}`;
    const wrongTx = (await execute([
      "jobs",
      "receipt",
      "job-1",
      "--rpc",
      "https://rpc.example",
    ])) as {
      verification: { verified: boolean };
    };
    expect(wrongTx.verification.verified).toBe(false);
  });

  test("a receipt that is not anchored yet says so", async () => {
    served = { ...served, anchor: null, proof: null };
    const result = (await execute([
      "jobs",
      "receipt",
      "job-1",
      "--rpc",
      "https://rpc.example",
    ])) as {
      verification: { verified: boolean; status: string };
    };
    expect(result.verification).toMatchObject({ verified: false, status: "not_anchored_yet" });
    expect(rpcCalls).toHaveLength(0);
  });

  test("uses the same canonical JSON as the API", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, "x"], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,"x"]},"b":1}',
    );
  });
});
