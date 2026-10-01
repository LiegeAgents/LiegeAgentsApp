import {
  decryptEscrowPrivateKey,
  decryptPayload,
  encryptEscrowPrivateKey,
  encryptPayload,
  keyring,
  payloadContext,
} from "../crypto.js";
import { db } from "./index.js";

// Re-encrypts every stored ciphertext that is not under the current DATA_ENCRYPTION_KEY,
// including legacy v1 rows. To rotate keys: move the old key to DATA_ENCRYPTION_KEY_PREVIOUS, set
// the new one, deploy, run this, then remove the previous key. Safe to re-run or run while the
// service is up; it fails loudly on any row it cannot decrypt.
type Target = {
  table: string;
  id: string;
  column: string;
  decrypt: (value: string, id: string) => string;
  encrypt: (value: string, id: string) => string;
};

const payload = (
  table: string,
  column: string,
  field: "brief" | "deliverable" | "rationale" | "artifact",
  id = table === "jobs" ? "id" : "job_id",
) => ({
  table,
  id,
  column,
  decrypt: (value: string, id: string) => decryptPayload(value, payloadContext(id, field)),
  encrypt: (value: string, id: string) => encryptPayload(value, payloadContext(id, field)),
});

const targets: Target[] = [
  payload("jobs", "brief_ciphertext", "brief"),
  payload("submissions", "deliverable_ciphertext", "deliverable"),
  payload("evaluations", "rationale_ciphertext", "rationale"),
  payload("evaluation_decisions", "rationale_ciphertext", "rationale", "task_id"),
  {
    table: "escrow_wallets",
    id: "job_id",
    column: "encrypted_private_key",
    decrypt: decryptEscrowPrivateKey,
    encrypt: encryptEscrowPrivateKey,
  },
];

export async function reencrypt(batchSize = 200) {
  const updated: Record<string, number> = {};
  for (const target of targets) {
    const name = `${target.table}.${target.column}`;
    updated[name] = 0;
    for (;;) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const rows = await client.query<{ id: string; value: string }>(
          `SELECT ${target.id}::text AS id, ${target.column} AS value FROM ${target.table}
           WHERE ${target.column} IS NOT NULL AND ${target.column} NOT LIKE $1
           LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [`v2.${keyring.currentKeyId}.%`, batchSize],
        );
        for (const row of rows.rows)
          await client.query(
            `UPDATE ${target.table} SET ${target.column} = $2 WHERE ${target.id} = $1`,
            [row.id, target.encrypt(target.decrypt(row.value, row.id), row.id)],
          );
        await client.query("COMMIT");
        updated[name] += rows.rowCount ?? 0;
        if ((rows.rowCount ?? 0) < batchSize) break;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
  return updated;
}

if (import.meta.main)
  reencrypt()
    .then((updated) => console.log("Re-encrypted rows:", updated))
    .finally(() => db.end());
