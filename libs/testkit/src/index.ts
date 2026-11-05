/**
 * Test fixtures for the compose stack.
 *
 * Integration tests use stackTest instead of test and get, on demand, their own database
 * copied from a migrated template (databaseUrl), their own Valkey key prefix (streamPrefix)
 * and a Valkey client that removes that prefix's keys afterwards (valkey). Wrap them in
 * describe.skipIf(!hasStack()) so they are skipped when the stack is not running.
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { inject, test } from "vitest";
import { createTestDatabase, VALKEY_URL } from "./stack.ts";

export * from "./data.ts";
export * from "./stack.ts";

/**
 * Whether to leave out the corpus runs that take minutes: the whole company drive, and the
 * Kubernetes pages and the GitLab policy history on the stack. `make check` sets
 * INSPIRATION_QUICK=1; CI and `make check-full` run them. The Kubernetes pages and the policy
 * history still run in memory, which checks the same numbers.
 */
export function quick(): boolean {
  return process.env.INSPIRATION_QUICK === "1";
}

/** Whether the global setup found the compose stack. */
export function hasStack(): boolean {
  return inject("inspirationStack");
}

export const stackTest = test
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  .extend("databaseUrl", async ({}, { onCleanup }) => {
    const db = await createTestDatabase();
    onCleanup(() => db.drop());
    return db.url;
  })
  // biome-ignore lint/correctness/noEmptyPattern: as above
  .extend("streamPrefix", async ({}) => `test-${randomUUID().replaceAll("-", "").slice(0, 10)}`)
  .extend("valkey", async ({ streamPrefix }, { onCleanup }) => {
    const client = new Redis(VALKEY_URL, { protocol: 2 });
    onCleanup(async () => {
      const keys = await client.keys(`${streamPrefix}:*`);
      if (keys.length) await client.del(...keys);
      await client.quit();
    });
    return client;
  });
