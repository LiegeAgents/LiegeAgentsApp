import { readdir } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/db/migrate.js";
import { databaseAvailable, db } from "./support.js";

describe.skipIf(!databaseAvailable)("migrations", () => {
  test("concurrent startups apply each migration exactly once", async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await Promise.all([migrate(), migrate(), migrate()]);

    const files = (await readdir(new URL("../db/migrations", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = await db.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(applied.rows.map((row) => row.filename)).toEqual(files);
  });

  test("an applied migration that was edited or removed stops startup", async () => {
    await migrate();
    await db.query(
      "UPDATE schema_migrations SET checksum = 'edited' WHERE filename = '001_initial.sql'",
    );
    await expect(migrate()).rejects.toThrow("001_initial.sql changed after it was applied");
    // Rows from before checksums existed are recorded on the next run.
    await db.query(
      "UPDATE schema_migrations SET checksum = NULL WHERE filename = '001_initial.sql'",
    );
    await migrate();
    const recorded = await db.query(
      "SELECT checksum FROM schema_migrations WHERE filename = '001_initial.sql'",
    );
    expect(recorded.rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    await db.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ('000_removed.sql', 'x')",
    );
    await expect(migrate()).rejects.toThrow("missing from the release: 000_removed.sql");
    await db.query("DELETE FROM schema_migrations WHERE filename = '000_removed.sql'");
  });
});
