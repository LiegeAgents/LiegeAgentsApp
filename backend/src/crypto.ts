import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "./config.js";

const key = createHash("sha256")
  .update(`liege-private-payload:v1:${env.DATA_ENCRYPTION_KEY ?? env.AUTH_TOKEN_PEPPER ?? ""}`)
  .digest();
export const hashPayload = (value: string) => createHash("sha256").update(value).digest("hex");

export function encryptPayload(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function decryptPayload(value: string) {
  const [version, iv, ciphertext, tag] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext || !tag)
    throw new Error("Unsupported private payload format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptEscrowPrivateKey(value: string) {
  return encryptPayload(`escrow-key:v1:${value}`);
}
export function decryptEscrowPrivateKey(value: string) {
  const payload = decryptPayload(value);
  if (!payload.startsWith("escrow-key:v1:")) throw new Error("Invalid encrypted escrow key.");
  return payload.slice("escrow-key:v1:".length);
}
