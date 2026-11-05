/**
 * Vitest global setup: decide whether the compose stack is available and, when it is,
 * build a migrated template database that every integration test copies.
 *
 * INSPIRATION_STACK=off       run unit tests only, without probing the stack
 * INSPIRATION_REQUIRE_STACK=1 fail instead of skipping when the stack is not reachable (CI)
 * INSPIRATION_QUICK=1         leave out the corpus runs that take minutes (`quick` in the testkit)
 */

import { applyMigrations } from "@inspiration/kernel";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { ADMIN_URL, admin, postgresReachable, TEMPLATE_DB, withDatabase } from "./stack.ts";

declare module "vitest" {
  export interface ProvidedContext {
    inspirationStack: boolean;
  }
}

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const required = process.env.INSPIRATION_REQUIRE_STACK === "1";
  const available = process.env.INSPIRATION_STACK !== "off" && (await postgresReachable());
  if (!available && required)
    throw new Error(`INSPIRATION_REQUIRE_STACK=1 but Postgres at ${ADMIN_URL} is not reachable`);
  project.provide("inspirationStack", available);
  if (!available) {
    console.warn("inspiration: compose stack not running (make up); integration tests are skipped");
    return undefined;
  }
  await admin(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`, `CREATE DATABASE ${TEMPLATE_DB}`);
  const url = withDatabase(ADMIN_URL, TEMPLATE_DB);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const ext of ["vector", "pg_search", "pg_trgm"]) await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
  } finally {
    await client.end();
  }
  await applyMigrations(url);
  return () => admin(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
}
