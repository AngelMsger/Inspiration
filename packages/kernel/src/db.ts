/** PostgreSQL connection pools and transactions. */

import pg from "pg";
import { logger } from "./log.ts";

const log = logger("kernel.db");

const INT8 = 20;

// int8 columns (sequence numbers, counts, token totals) stay well inside 2^53, so read them
// as numbers rather than pg's default strings.
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8 && format !== "binary") return (value: string) => Number(value);
    // biome-ignore lint/suspicious/noExplicitAny: pg's overloads do not accept a union format
    return pg.types.getTypeParser(oid, format as any);
  },
} as pg.CustomTypesConfig;

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.ClientBase, "query">;

/** Open a pool and check that the database answers. */
export async function openPool(databaseUrl: string, options: { max?: number } = {}): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: options.max ?? 10, types });
  // An idle connection that the server drops emits "error" on the pool; without a listener
  // the process would crash.
  pool.on("error", (error) => log.warn("idle connection failed", { error }));
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    await pool.end();
    throw e;
  }
  return pool;
}

/** One connection, with the same type parsing as the pools. */
export async function connect(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl, types });
  await client.connect();
  return client;
}

/** Run fn in a transaction on one pooled connection: COMMIT when it resolves, ROLLBACK when it throws. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
