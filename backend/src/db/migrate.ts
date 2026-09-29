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
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const filename of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (alreadyApplied.rowCount) continue;
      try {
        await client.query("BEGIN");
        await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
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
