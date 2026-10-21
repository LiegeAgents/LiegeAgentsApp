// Checks that a Liege document (a job receipt or a reputation snapshot) was anchored on Robinhood
// Chain, in the browser, using only the document, its Merkle proof, and public chain data.
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
const PREFIX = "LIEGE:RECEIPTS:v1";

const toBytes = (hex) =>
  Uint8Array.from(hex.replace(/^0x/, "").match(/../g) || [], (b) => parseInt(b, 16));
const toHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const sha256 = async (...parts) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

/**
 * Recomputes the document's leaf and Merkle root and checks the anchoring transaction. `noun`
 * names the document in the first check ("receipt", "snapshot").
 */
export async function verifyAnchored({ document, leaf: expectedLeaf, proof, anchor }, noun) {
  const encoder = new TextEncoder();
  const leaf = await sha256(new Uint8Array([0]), encoder.encode(canonical(document)));
  let node = leaf;
  for (const sibling of proof) {
    const other = toBytes(sibling);
    node =
      compare(node, other) <= 0
        ? await sha256(new Uint8Array([1]), node, other)
        : await sha256(new Uint8Array([1]), other, node);
  }
  const root = toHex(node);
  const rpc = async (method) =>
    (
      await (
        await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [anchor.txHash] }),
        })
      ).json()
    ).result;
  const [tx, mined] = await Promise.all([
    rpc("eth_getTransactionByHash"),
    rpc("eth_getTransactionReceipt"),
  ]);
  return [
    [`The ${noun} hashes to its leaf`, toHex(leaf) === expectedLeaf],
    ["The proof leads to the batch root", root === anchor.merkleRoot],
    [
      "The transaction carries this root",
      tx?.input?.toLowerCase() === toHex(concat(encoder.encode(PREFIX), toBytes(root))),
    ],
    [
      "It was sent by Liege's receipt wallet",
      tx?.from?.toLowerCase() === anchor.anchorAddress?.toLowerCase(),
    ],
    ["It succeeded on Robinhood Chain", mined?.status === "0x1"],
  ];
}
