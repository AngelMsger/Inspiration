/** Where the compose stack's services are for tests. Override with INSPIRATION_TEST_* variables. */

import { randomUUID } from "node:crypto";
import pg from "pg";

const env = process.env;

export const ADMIN_URL =
  env.INSPIRATION_TEST_ADMIN_URL ?? "postgresql://inspiration:inspiration@localhost:5432/postgres";
/** Database 15, so tests never touch a developer's data in database 0. */
export const VALKEY_URL = env.INSPIRATION_TEST_VALKEY_URL ?? "redis://localhost:6379/15";
export const SPICEDB_ENDPOINT = env.INSPIRATION_TEST_SPICEDB_ENDPOINT ?? "localhost:50051";
export const SPICEDB_KEY = env.INSPIRATION_TEST_SPICEDB_KEY ?? "inspiration-dev-key";
export const TEMPLATE_DB = "inspiration_test_template";

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Run statements on the admin database, one connection each time. */
export async function admin(...statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function postgresReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A new database copied from the migrated template. */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `inspiration_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // CREATE DATABASE refuses while another session is copying the same template, and test
  // files run in parallel, so retry briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      await admin(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
      break;
    } catch (e) {
      if (attempt >= 20 || !/being accessed by other users/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
  return {
    url: withDatabase(ADMIN_URL, name),
    drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
