import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyring, keyring } from "../src/crypto.js";
import { reencrypt } from "../src/db/reencrypt.js";
import { ensureEscrowWallet, escrowSigner } from "../src/escrow.js";
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

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

// The format written before key IDs and associated data existed.
function legacyEncrypt(value: string, secret: string) {
  const key = createHash("sha256").update(`liege-private-payload:v1:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

test("ciphertexts are bound to their purpose, record, and key", () => {
  const ring = createKeyring({ current: KEY_A });
  const sealed = ring.encrypt("private brief", "payload", "job:1:brief");
  expect(sealed.startsWith(`v2.${ring.currentKeyId}.`)).toBe(true);
  expect(ring.decrypt(sealed, "payload", "job:1:brief")).toBe("private brief");
  expect(() => ring.decrypt(sealed, "payload", "job:2:brief")).toThrow();
  expect(() => ring.decrypt(sealed, "escrow-key", "job:1:brief")).toThrow();
  const [version, keyId, iv, ciphertext, tag] = sealed.split(".");
  const flipped = ciphertext[0] === "A" ? "B" : "A";
  const tampered = [version, keyId, iv, `${flipped}${ciphertext.slice(1)}`, tag].join(".");
  expect(() => ring.decrypt(tampered, "payload", "job:1:brief")).toThrow();
});

test("rotation keeps old ciphertexts readable only while the previous key is configured", () => {
  const sealed = createKeyring({ current: KEY_A }).encrypt("brief", "payload", "job:1:brief");
  const rotated = createKeyring({ current: KEY_B, previous: [KEY_A] });
  expect(rotated.decrypt(sealed, "payload", "job:1:brief")).toBe("brief");
  expect(rotated.isCurrent(sealed)).toBe(false);
  expect(() => createKeyring({ current: KEY_B }).decrypt(sealed, "payload", "job:1:brief")).toThrow(
    "unknown key",
  );
});

test("legacy ciphertexts decrypt under either secret they may have used", () => {
  const underPepper = legacyEncrypt("old brief", KEY_B);
  const ring = createKeyring({ current: KEY_A, legacy: [KEY_A, KEY_B] });
  expect(ring.decrypt(underPepper, "payload", "ignored for v1")).toBe("old brief");
  expect(() =>
    createKeyring({ current: KEY_A, legacy: [KEY_A] }).decrypt(underPepper, "payload", ""),
  ).toThrow();
});

test("payload digests are keyed", () => {
  const a = createKeyring({ current: KEY_A });
  expect(a.digest("brief")).toBe(a.digest("brief"));
  expect(a.digest("brief")).not.toBe(createKeyring({ current: KEY_B }).digest("brief"));
  expect(a.digest("brief")).not.toContain(createHash("sha256").update("brief").digest("hex"));
});

describe.skipIf(!databaseAvailable)("re-encryption", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("upgrades legacy rows to the current key without changing their contents", async () => {
    const [client, provider] = await Promise.all([signIn(), signIn()]);
    const jobId = await createJob(client, await createAgent(provider), 40);
    // In tests the legacy secret is empty, as it was when neither key was set.
    await db.query("UPDATE jobs SET brief_ciphertext = $2 WHERE id = $1", [
      jobId,
      legacyEncrypt("Legacy brief.", ""),
    ]);
    const escrowKey = `0x${"42".repeat(32)}` as const;
    await ensureEscrowWallet(db, jobId);
    await db.query("UPDATE escrow_wallets SET encrypted_private_key = $2 WHERE job_id = $1", [
      jobId,
      legacyEncrypt(`escrow-key:v1:${escrowKey}`, ""),
    ]);

    expect(await reencrypt()).toMatchObject({
      "jobs.brief_ciphertext": 1,
      "escrow_wallets.encrypted_private_key": 1,
    });
    const stored = await db.query(
      "SELECT j.brief_ciphertext, ew.encrypted_private_key FROM jobs j JOIN escrow_wallets ew ON ew.job_id = j.id WHERE j.id = $1",
      [jobId],
    );
    expect(keyring.isCurrent(stored.rows[0].brief_ciphertext)).toBe(true);
    expect(keyring.isCurrent(stored.rows[0].encrypted_private_key)).toBe(true);
    const job = await api().get(`/v1/jobs/${jobId}`).set(bearer(client)).expect(200);
    expect(job.body.data.brief).toBe("Legacy brief.");
    expect((await escrowSigner(db, jobId)).address).toBe(privateKeyToAccount(escrowKey).address);
    expect(Object.values(await reencrypt()).every((count) => count === 0)).toBe(true);
  });
});
