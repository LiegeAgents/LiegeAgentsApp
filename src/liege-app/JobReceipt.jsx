import React, { useEffect, useState } from "react";
import { BadgeCheck, Download, ExternalLink, Link2 } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";
import { EXPLORER, verifyAnchored } from "./anchorVerify";

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

/** Checks the receipt's anchoring and, when the delivery was signed, the agent's signature. */
async function verify(data) {
  const checks = await verifyAnchored(
    { document: data.receipt, leaf: data.leaf, proof: data.proof, anchor: data.anchor },
    "receipt",
  );
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
