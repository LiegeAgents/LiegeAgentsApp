import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { env } from "./config.js";

// Private payloads and escrow keys are encrypted at rest with keys the server holds; the server
// can read them, so this is not end-to-end encryption.
//
// v2 (current): AES-256-GCM under a key derived from DATA_ENCRYPTION_KEY separately for each
// purpose. The ciphertext names its key and is bound, as associated data, to its purpose and
// record, so it cannot be moved to another row or field.
// v1 (legacy, read-only): AES-256-GCM under SHA-256 of one secret with no associated data. That
// secret was DATA_ENCRYPTION_KEY, or AUTH_TOKEN_PEPPER when no data key was set, so both are tried.

export type Purpose = "payload" | "escrow-key";

const DEVELOPMENT_KEY = "liege-development-only-data-encryption-key";

type Key = { id: string; secret: string };
const keyOf = (secret: string): Key => ({
  id: createHash("sha256").update(`liege-key-id:${secret}`).digest("hex").slice(0, 12),
  secret,
});
const derive = (secret: string, purpose: Purpose | "payload-digest") =>
  Buffer.from(hkdfSync("sha256", secret, "liege", `liege:${purpose}:v2`, 32));

export function createKeyring(secrets: {
  current: string;
  previous?: string[];
  legacy?: string[];
}) {
  const current = keyOf(secrets.current);
  const known = new Map(
    [current, ...(secrets.previous ?? []).map(keyOf)].map((key) => [key.id, key]),
  );
  const legacyKeys = (secrets.legacy ?? []).map((secret) =>
    createHash("sha256").update(`liege-private-payload:v1:${secret}`).digest(),
  );
  const associatedData = (keyId: string, purpose: Purpose, context: string) =>
    Buffer.from(`v2|${keyId}|${purpose}|${context}`);

  function encrypt(value: string, purpose: Purpose, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derive(current.secret, purpose), iv);
    cipher.setAAD(associatedData(current.id, purpose, context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v2.${current.id}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  function decryptWith(key: Buffer, iv: string, ciphertext: string, tag: string, aad?: Buffer) {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  function decrypt(value: string, purpose: Purpose, context: string) {
    const parts = value.split(".");
    if (parts[0] === "v2" && parts.length === 5) {
      const [, keyId, iv, ciphertext, tag] = parts;
      const key = known.get(keyId);
      if (!key) throw new Error(`Private payload uses unknown key ${keyId}.`);
      return decryptWith(
        derive(key.secret, purpose),
        iv,
        ciphertext,
        tag,
        associatedData(keyId, purpose, context),
      );
    }
    if (parts[0] === "v1" && parts.length === 4) {
      for (const key of legacyKeys) {
        try {
          return decryptWith(key, parts[1], parts[2], parts[3]);
        } catch {}
      }
      throw new Error("Private payload does not decrypt under any legacy key.");
    }
    throw new Error("Unsupported private payload format.");
  }

  return {
    currentKeyId: current.id,
    encrypt,
    decrypt,
    isCurrent: (value: string) => value.startsWith(`v2.${current.id}.`),
    // Keyed, so a leaked digest cannot be used to guess low-entropy payloads offline.
    digest: (value: string) =>
      `hmac-sha256:${createHmac("sha256", derive(current.secret, "payload-digest")).update(value).digest("hex")}`,
  };
}

export const keyring = createKeyring({
  current: env.DATA_ENCRYPTION_KEY ?? DEVELOPMENT_KEY,
  previous: env.DATA_ENCRYPTION_KEY_PREVIOUS ? [env.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
  legacy: [
    ...new Set(
      [
        env.DATA_ENCRYPTION_KEY,
        env.DATA_ENCRYPTION_KEY_PREVIOUS,
        env.AUTH_TOKEN_PEPPER,
        env.NODE_ENV === "production" ? undefined : "",
      ].filter((secret): secret is string => secret !== undefined),
    ),
  ],
});

export const payloadContext = (
  jobId: string,
  field: "brief" | "deliverable" | "rationale" | "webhook-secret",
) => `job:${jobId}:${field}`;
export const encryptPayload = (value: string, context: string) =>
  keyring.encrypt(value, "payload", context);
export const decryptPayload = (value: string, context: string) =>
  keyring.decrypt(value, "payload", context);
export const payloadDigest = (value: string) => keyring.digest(value);

export const encryptEscrowPrivateKey = (value: string, jobId: string) =>
  keyring.encrypt(value, "escrow-key", `job:${jobId}`);
export function decryptEscrowPrivateKey(value: string, jobId: string) {
  if (value.startsWith("v2.")) return keyring.decrypt(value, "escrow-key", `job:${jobId}`);
  const legacy = keyring.decrypt(value, "payload", "");
  if (!legacy.startsWith("escrow-key:v1:")) throw new Error("Invalid encrypted escrow key.");
  return legacy.slice("escrow-key:v1:".length);
}
