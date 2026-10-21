import React, { useEffect, useState } from "react";
import { BadgeCheck, Download, ExternalLink, Link2 } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";
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

const fromBase64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Checks the agent's Ed25519 signature over this deliverable with the key in the receipt. */
async function signatureCheck(receipt) {
  const signed = receipt.deliverableSignature;
  const message = `liege-deliverable:v1:${receipt.jobId}:${receipt.deliverableSha256}`;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64(signed.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64(signed.signature),
      new TextEncoder().encode(message),
    );
    return ["The agent signed this exact deliverable", ok];
  } catch {
    return ["This browser cannot check Ed25519 signatures; try an up-to-date browser", false];
  }
}

/** Recomputes the receipt's place onchain in this browser, using only public chain data. */
async function verify(data) {
  const encoder = new TextEncoder();
  const leaf = await sha256(new Uint8Array([0]), encoder.encode(canonical(data.receipt)));
  let node = leaf;
  for (const sibling of data.proof) {
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
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [data.anchor.txHash] }),
        })
      ).json()
    ).result;
  const [tx, mined] = await Promise.all([
    rpc("eth_getTransactionByHash"),
    rpc("eth_getTransactionReceipt"),
  ]);
  const checks = [
    ["The receipt hashes to its leaf", toHex(leaf) === data.leaf],
    ["The proof leads to the batch root", root === data.anchor.merkleRoot],
    [
      "The transaction carries this root",
      tx?.input?.toLowerCase() === toHex(concat(encoder.encode(PREFIX), toBytes(root))),
    ],
    [
      "It was sent by Liege's receipt wallet",
      tx?.from?.toLowerCase() === data.anchor.anchorAddress?.toLowerCase(),
    ],
    ["It succeeded on Robinhood Chain", mined?.status === "0x1"],
  ];
  if (data.receipt.deliverableSignature) checks.push(await signatureCheck(data.receipt));
  return checks;
}

/**
 * A settled job's onchain receipt. Only a Merkle root goes onchain; the parties hold the receipt
 * and proof, and anyone can check them against the transaction.
 */
export default function JobReceipt({ jobId, token, status }) {
  const settled = ["completed", "rejected"].includes(String(status).toLowerCase());
  const [data, setData] = useState(null),
    [note, setNote] = useState(""),
    [checks, setChecks] = useState(null),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!settled) return;
    api
      .jobReceipt(token, jobId)
      .then((result) => setData(result.data))
      .catch((e) => setNote(e?.message || "The receipt is not available yet."));
  }, [jobId, settled]);
  if (!settled) return null;
  const anchor = data?.anchor;
  const download = () => {
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    Object.assign(document.createElement("a"), {
      href,
      download: `liege-receipt-${data.receipt.job}.json`,
    }).click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const runCheck = async () => {
    setChecking(true);
    try {
      // Before the receipt is anchored, only the agent's signature can be checked.
      setChecks(anchor?.txHash ? await verify(data) : [await signatureCheck(data.receipt)]);
    } catch {
      setChecks([["Robinhood Chain could not be reached; try again", false]]);
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="job-receipt">
      <h3>Onchain receipt</h3>
      {!data ? (
        <p className="muted">{note || "Loading…"}</p>
      ) : (
        <>
          <p className="muted">
            {!anchor
              ? "The receipt is ready and waiting for the next batch to be written to Robinhood Chain."
              : anchor.status === "confirmed"
                ? `Anchored on Robinhood Chain in block ${anchor.blockNumber}. Only a fingerprint is onchain; the details stay private to this job's parties.`
                : "Sent to Robinhood Chain and waiting for confirmation."}
          </p>
          <dl className="receipt-facts">
            <div>
              <dt>Outcome</dt>
              <dd>
                {data.receipt.outcome === "completed"
                  ? "Accepted and paid"
                  : "Rejected and refunded"}
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {data.receipt.budget} {String(data.receipt.asset).toUpperCase()}
              </dd>
            </div>
            <div>
              <dt>Receipt fingerprint</dt>
              <dd title={data.leaf}>{data.leaf.slice(0, 18)}…</dd>
            </div>
            {data.receipt.deliverableSignature && (
              <div>
                <dt>Signed by the agent</dt>
                <dd title={data.receipt.deliverableSignature.publicKey}>
                  Ed25519 key {data.receipt.deliverableSignature.publicKey.slice(0, 10)}…
                </dd>
              </div>
            )}
            {anchor?.txHash && (
              <div>
                <dt>Transaction</dt>
                <dd>
                  <a
                    href={`${EXPLORER}/tx/${anchor.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {anchor.txHash.slice(0, 12)}… <ExternalLink size={11} />
                  </a>
                </dd>
              </div>
            )}
          </dl>
          <div className="receipt-actions">
            {((anchor?.txHash && data.proof) || data.receipt.deliverableSignature) && (
              <Button small secondary disabled={checking} onClick={runCheck}>
                <BadgeCheck size={13} />{" "}
                {checking
                  ? "Checking…"
                  : anchor?.txHash
                    ? "Verify it yourself"
                    : "Check the agent's signature"}
              </Button>
            )}
            <Button small secondary onClick={download}>
              <Download size={13} /> Download receipt
            </Button>
          </div>
          {checks && (
            <ul className="receipt-checks">
              {checks.map(([label, ok]) => (
                <li key={label} className={ok ? "ok" : "bad"}>
                  {ok ? <BadgeCheck size={13} /> : <Link2 size={13} />} {label}
                </li>
              ))}
            </ul>
          )}
          {checks && checks.every(([, ok]) => ok) && (
            <Notice>
              {anchor?.txHash
                ? "Verified in your browser against Robinhood Chain. No Liege server was trusted."
                : "Checked in your browser with the agent's public key. No Liege server was trusted."}
            </Notice>
          )}
        </>
      )}
    </section>
  );
}
