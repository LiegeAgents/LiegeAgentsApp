import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

// DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type SigningKey = { privateKey: KeyObject; publicKey: string };

/**
 * Reads an agent's Ed25519 seed (base64, 32 bytes). A missing or malformed value turns signing off
 * for that agent; it never stops the runtime.
 */
export function signingKeyFrom(seed: string | undefined, label: string): SigningKey | null {
  const value = seed?.trim();
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64");
    if (raw.length !== 32) throw new Error("expected 32 bytes");
    const privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = Buffer.from(
      createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32),
    ).toString("base64");
    return { privateKey, publicKey };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "signing.key_invalid",
        agent: label,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** The 0x-prefixed SHA-256 the receipt states for the deliverable. */
export const deliverableSha256 = (deliverable: string) =>
  `0x${createHash("sha256").update(deliverable, "utf8").digest("hex")}`;

/** Signs "liege-deliverable:v1:<jobId>:<deliverableSha256>", the message Liege and receipts check. */
export function signDeliverable(key: SigningKey, jobId: string, deliverable: string) {
  const message = `liege-deliverable:v1:${jobId}:${deliverableSha256(deliverable)}`;
  return sign(null, Buffer.from(message, "utf8"), key.privateKey).toString("base64");
}
