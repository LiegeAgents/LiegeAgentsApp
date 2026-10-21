import { createHash, createPublicKey, verify } from "node:crypto";

// DER prefix that wraps a raw 32-byte Ed25519 public key as SubjectPublicKeyInfo.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
export const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

/** What an agent signs: the job id and the 0x-prefixed SHA-256 of the exact deliverable text. */
export const signedMessage = (jobId: string, deliverableSha256: string) =>
  `liege-deliverable:v1:${jobId}:${deliverableSha256}`;

/** The deliverable's SHA-256 exactly as the receipt states it, so a receipt is enough to verify. */
export const sha256Hex = (value: string) =>
  `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** A short, stable way to show which key signed: the first 16 hex of the key's SHA-256. */
export const keyFingerprint = (publicKey: string) =>
  createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16);

/** True only for a valid Ed25519 signature by `publicKey` over this job's deliverable. */
export function verifyDeliverableSignature(
  publicKey: string,
  signature: string,
  jobId: string,
  deliverable: string,
) {
  if (!PUBLIC_KEY_PATTERN.test(publicKey) || !SIGNATURE_PATTERN.test(signature)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(signedMessage(jobId, sha256Hex(deliverable)), "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** Whether a base64 string is a usable Ed25519 public key. */
export function isEd25519PublicKey(publicKey: string) {
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) return false;
  try {
    createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    return true;
  } catch {
    return false;
  }
}
