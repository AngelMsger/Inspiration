import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasStack, stackTest as test } from "@inspiration/testkit";
import { describe, expect } from "vitest";
import { applyMigrations, connect, discoverMigrations, type MigrationSet } from "../src/index.ts";

function sqlDir(files: Record<string, string>): URL {
  const dir = mkdtempSync(join(tmpdir(), "inspiration-sql-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return pathToFileURL(`${dir}/`);
}

test("migration sets are discovered in run order", async () => {
  expect((await discoverMigrations()).map((s) => s.component)).toEqual([
    "bus",
    "gateway",
    "kb",
    "agents",
    "sync",
    "normalization",
    "extraction",
    "governance",
    "freshness",
    "page-compiler",
    "collaboration",
  ]);
});

describe.skipIf(!hasStack())("applying migrations", () => {
  test("applies pending files once and refuses edited ones", async ({ databaseUrl }) => {
    const directory = sqlDir({
      "0001_init.sql": "CREATE SCHEMA demo; CREATE TABLE demo.t (id int);",
      "0002_more.sql": "ALTER TABLE demo.t ADD COLUMN name text;",
    });
    const set: MigrationSet = { component: "demo", directory, order: 100 };
    expect(await applyMigrations(databaseUrl, [set])).toEqual(["demo/0001_init", "demo/0002_more"]);
    expect(await applyMigrations(databaseUrl, [set])).toEqual([]);

    writeFileSync(new URL("0002_more.sql", directory), "ALTER TABLE demo.t ADD COLUMN title text;");
    await expect(applyMigrations(databaseUrl, [set])).rejects.toThrow("demo/0002_more changed after it was applied");
  });

  test("a failing file rolls back and stops", async ({ databaseUrl }) => {
    const set: MigrationSet = {
      component: "broken",
      directory: sqlDir({ "0001_bad.sql": "CREATE TABLE public.half (id int); SELECT no_such_function();" }),
      order: 100,
    };
    await expect(applyMigrations(databaseUrl, [set])).rejects.toThrow(/broken\/0001_bad failed/);
    const client = await connect(databaseUrl);
    try {
      const { rows } = await client.query("SELECT to_regclass('public.half') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });
});
