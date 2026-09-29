import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./index.js";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

export async function migrate() {
  const client = await db.connect();
  try {
    // Every API process migrates on startup. The session-level lock makes concurrent replicas wait
    // for the first one and then find nothing left to apply.
    await client.query("SELECT pg_advisory_lock(hashtext('liege:schema_migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    // Rows recorded before checksums existed have none; the first run records the current file's.
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = new Map(
      (
        await client.query<{ filename: string; checksum: string | null }>(
          "SELECT filename, checksum FROM schema_migrations",
        )
      ).rows.map((row) => [row.filename, row.checksum]),
    );
    const missing = [...applied.keys()].filter((filename) => !files.includes(filename));
    if (missing.length)
      throw new Error(`Applied migrations are missing from the release: ${missing.join(", ")}.`);
    for (const filename of files) {
      const sql = await readFile(join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(filename)) {
        const recorded = applied.get(filename);
        if (recorded === null)
          await client.query("UPDATE schema_migrations SET checksum = $2 WHERE filename = $1", [
            filename,
            checksum,
          ]);
        else if (recorded !== checksum)
          throw new Error(
            `Migration ${filename} changed after it was applied. Add a new migration instead of editing an applied one.`,
          );
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
          filename,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    const unlocked = await client
      .query("SELECT pg_advisory_unlock(hashtext('liege:schema_migrations'))")
      .then(
        () => true,
        () => false,
      );
    // A connection that may still hold the lock is closed rather than returned to the pool.
    client.release(!unlocked);
  }
}

if (import.meta.main) migrate().finally(() => db.end());
