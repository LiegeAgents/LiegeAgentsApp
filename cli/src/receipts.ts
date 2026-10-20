import { createHash } from "node:crypto";

/**
 * Checks a Liege job receipt against Robinhood Chain without trusting Liege: rebuild the leaf
 * from the receipt, fold in the proof, and compare the root with the anchoring transaction.
 * This mirrors the API's method on purpose; it shares no code with it.
 */
export const ANCHOR_PREFIX = "LIEGE:RECEIPTS:v1";
export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

type Proof = {
  receipt: Record<string, unknown>;
  leaf: string;
  proof: string[] | null;
  anchor: {
    status: string;
    merkleRoot: string;
    chainId: number;
    anchorAddress: string | null;
    txHash: string | null;
  } | null;
};

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const bytes = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex");
const hex = (value: Buffer) => `0x${value.toString("hex")}`;

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
};

export const receiptLeaf = (receipt: unknown) =>
  hex(sha256(Buffer.from([0]), Buffer.from(canonicalJson(receipt), "utf8")));

export function foldProof(leaf: string, proof: string[]) {
  return hex(
    proof.reduce((node, sibling) => {
      const other = bytes(sibling);
      return Buffer.compare(node, other) <= 0
        ? sha256(Buffer.from([1]), node, other)
        : sha256(Buffer.from([1]), other, node);
    }, bytes(leaf)),
  );
}

export async function verifyReceipt(data: Proof, rpcUrl = DEFAULT_RPC_URL) {
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const leaf = receiptLeaf(data.receipt);
  checks.push({ check: "receipt hashes to its leaf", ok: leaf === data.leaf.toLowerCase() });
  if (!data.anchor || !data.proof)
    return { verified: false, status: "not_anchored_yet", leaf, checks };
  const root = foldProof(leaf, data.proof);
  checks.push({
    check: "proof leads to the batch root",
    ok: root === data.anchor.merkleRoot.toLowerCase(),
  });
  if (!data.anchor.txHash) return { verified: false, status: "not_sent_yet", leaf, root, checks };
  const call = async (method: string) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [data.anchor!.txHash] }),
    });
    return ((await response.json()) as { result?: Record<string, string> | null }).result ?? null;
  };
  const [transaction, receipt] = await Promise.all([
    call("eth_getTransactionByHash"),
    call("eth_getTransactionReceipt"),
  ]);
  const expected = `0x${Buffer.from(ANCHOR_PREFIX).toString("hex")}${root.slice(2)}`;
  checks.push({
    check: "transaction input is the Liege prefix plus this root",
    ok: transaction?.input?.toLowerCase() === expected,
  });
  checks.push({
    check: "transaction was sent by the anchor wallet",
    ok:
      Boolean(data.anchor.anchorAddress) &&
      transaction?.from?.toLowerCase() === data.anchor.anchorAddress!.toLowerCase(),
  });
  checks.push({
    check: "transaction is on the receipt's chain",
    ok:
      transaction?.chainId !== undefined &&
      Number(transaction.chainId) === Number(data.receipt.chainId),
  });
  const mined = receipt?.status === "0x1";
  checks.push({
    check: "transaction succeeded onchain",
    ok: mined,
    ...(receipt?.blockNumber ? { detail: `block ${Number(receipt.blockNumber)}` } : {}),
  });
  return {
    verified: checks.every((check) => check.ok),
    status: mined ? "anchored" : "pending",
    leaf,
    root,
    txHash: data.anchor.txHash,
    checks,
  };
}
