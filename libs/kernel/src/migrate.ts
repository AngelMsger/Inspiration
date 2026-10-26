/**
 * Plain-SQL migrations, owned per component.
 *
 * Each package that owns tables ships numbered SQL files ("migrations/0001_init.sql") and
 * declares a MigrationSet in the "migrations" plugin group. Components own separate
 * Postgres schemas (bus, kb, gateway, agents), so they never share tables. Applied files are
 * recorded with a checksum; editing an applied file is an error, add a new file instead.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "./db.ts";
import { registry } from "./plugins.ts";

/** Advisory lock held while migrating, so concurrent deploys apply each file once. */
export const MIGRATION_LOCK = 0x1a50001;

const LEDGER = `
CREATE TABLE IF NOT EXISTS public.inspiration_migrations (
    component  text        NOT NULL,
    version    text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (component, version)
)`;

export interface MigrationSet {
  /** Ledger key, usually the Postgres schema the files create. */
  readonly component: string;
  /** Directory URL of the SQL files, for example new URL("../migrations/", import.meta.url). */
  readonly directory: URL;
  /** Lower runs first, so a schema others refer to (the event bus) gets a small number. */
  readonly order: number;
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** The set's SQL files as [version, text], in file name order. */
export function migrationFiles(set: MigrationSet): [string, string][] {
  return readdirSync(set.directory)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => [f.replace(/\.sql$/, ""), readFileSync(new URL(f, set.directory), "utf8")]);
}

function isMigrationSet(value: unknown): value is MigrationSet {
  const v = value as MigrationSet;
  return typeof v?.component === "string" && v.directory instanceof URL && typeof v.order === "number";
}

function sorted(sets: readonly MigrationSet[]): MigrationSet[] {
  return [...sets].sort((a, b) => a.order - b.order || a.component.localeCompare(b.component));
}

/** Every declared migration set, in the order they run. */
export async function discoverMigrations(): Promise<MigrationSet[]> {
  const sets: MigrationSet[] = [];
  for (const plugin of registry("migrations").plugins()) {
    const set = await plugin.load();
    if (!isMigrationSet(set)) throw new MigrationError(`migrations plugin ${plugin.name} is not a MigrationSet`);
    sets.push(set);
  }
  return sorted(sets);
}

/** Apply pending migrations. Returns the "component/version" names applied. */
export async function applyMigrations(databaseUrl: string, sets?: readonly MigrationSet[]): Promise<string[]> {
  const ordered = sets ? sorted(sets) : await discoverMigrations();
  const appliedNow: string[] = [];
  const client = await connect(databaseUrl);
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await client.query(LEDGER);
      const { rows } = await client.query<{ component: string; version: string; checksum: string }>(
        "SELECT component, version, checksum FROM public.inspiration_migrations",
      );
      const done = new Map(rows.map((r) => [`${r.component}/${r.version}`, r.checksum]));
      for (const set of ordered) {
        for (const [version, sql] of migrationFiles(set)) {
          const key = `${set.component}/${version}`;
          const checksum = createHash("sha256").update(sql).digest("hex");
          const known = done.get(key);
          if (known !== undefined) {
            if (known !== checksum) throw new MigrationError(`${key} changed after it was applied`);
            continue;
          }
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query(
              "INSERT INTO public.inspiration_migrations (component, version, checksum) VALUES ($1, $2, $3)",
              [set.component, version, checksum],
            );
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            throw new MigrationError(`${key} failed: ${(e as Error).message}`, { cause: e });
          }
          appliedNow.push(key);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    await client.end();
  }
  return appliedNow;
}
