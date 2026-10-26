import type { DataColumn, DataProvider, DataTable, EventEnvelope } from "@inspiration/contracts";
import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { type BaseStore, MemoryStore, PostgresStore } from "../src/index.ts";
import { Sample, T0 } from "../src/testing.ts";

export type Backend = "memory" | "postgres";

/** The backends every contract test runs against; Postgres only when the stack is up. */
export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

/** A data provider that echoes its parameters, for QueryData tests. */
export class StaticProvider implements DataProvider {
  readonly name = "static";

  async run(
    queryId: string,
    params: Readonly<Record<string, unknown>>,
    columns: readonly DataColumn[],
  ): Promise<DataTable> {
    return { columns: [...columns], rows: [[queryId, params.n ?? 0]], resolved_at: T0.toISOString() };
  }
}

/**
 * Tests with a fresh store of the given backend (kb's clock is the store's clock) and the
 * events committed through it: MemoryStore.published, or bus.outbox for Postgres.
 */
export function storeTest(backend: Backend) {
  return (
    test
      // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
      .extend("kb", async ({}) => new Sample())
      .extend("store", async ({ kb }, { onCleanup }): Promise<BaseStore> => {
        const options = { dataProviders: [new StaticProvider()], clock: () => kb.now };
        if (backend === "memory") return new MemoryStore(options);
        const db = await createTestDatabase();
        const pool = await openPool(db.url);
        onCleanup(async () => {
          await pool.end();
          await db.drop();
        });
        return new PostgresStore(pool, options);
      })
      .extend("published", async ({ store }) => async (): Promise<EventEnvelope[]> => {
        if (!(store instanceof PostgresStore)) return [...(store as MemoryStore).published];
        const { rows } = await store.pool.query<{ envelope: EventEnvelope }>(
          "SELECT envelope FROM bus.outbox ORDER BY seq",
        );
        return rows.map((r) => r.envelope);
      })
  );
}
