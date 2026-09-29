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
});
