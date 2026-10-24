// Record tables behave the same in memory and on Postgres.

import { type EventEnvelope, newEvent, newId } from "@inspiration/contracts";
import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { defineTable, MemoryRecords, PgRecords, type Records } from "../src/index.ts";

const TENANT = "ten_01JC0000000000000000000001";

interface Item {
  source_id: string;
  external_id: string;
  rank?: number;
  title: string;
}

const ITEMS = defineTable<Item>("test_records.items", {
  key: (i) => `${i.source_id}:${i.external_id}`,
  columns: { source_id: (i) => i.source_id, rank: (i) => i.rank },
  types: { rank: "integer" },
});

const DDL = `
CREATE SCHEMA test_records;
CREATE TABLE test_records.items (key text PRIMARY KEY, source_id text NOT NULL, rank integer, doc jsonb NOT NULL);`;

const item = (source: string, external: string, rank?: number): Item => ({
  source_id: source,
  external_id: external,
  title: `${source} ${external}`,
  ...(rank !== undefined && { rank }),
});

function claimsEvent(): EventEnvelope {
  return newEvent(
    "claims.updated",
    { origin: "extracted", added: [newId("claim")], updated: [], superseded: [] },
    { tenantId: TENANT, producer: "extraction" },
  );
}

type Backend = "memory" | "postgres";

const recordsTest = (backend: Backend) =>
  test
    // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
    .extend("records", async ({}, { onCleanup }): Promise<Records> => {
      if (backend === "memory") return new MemoryRecords();
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      await pool.query(DDL);
      onCleanup(async () => {
        await pool.end();
        await db.drop();
      });
      return new PgRecords(pool);
    })
    .extend("published", async ({ records }) => async (): Promise<string[]> => {
      if (records instanceof MemoryRecords) return records.published.map((e) => e.id);
      const { rows } = await (records as PgRecords).pool.query<{ event_id: string }>(
        "SELECT event_id FROM bus.outbox ORDER BY seq",
      );
      return rows.map((r) => r.event_id);
    });

describe.each<{ backend: Backend; skip: boolean }>([
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
])("records on $backend", ({ backend, skip }) => {
  const it = recordsTest(backend);

  it.skipIf(skip)("put, get, find and count", async ({ records }) => {
    await records.transaction(async (tx) => {
      await tx.put(ITEMS, [item("src_b", "2", 2), item("src_a", "1", 3), item("src_a", "Z"), item("src_a", "a", 1)]);
    });
    expect((await records.get(ITEMS, "src_a:1"))?.title).toBe("src_a 1");
    expect(await records.get(ITEMS, "src_a:missing")).toBeUndefined();
    expect((await records.getMany(ITEMS, ["src_b:2", "nope", "src_a:1"])).map((i) => i.external_id)).toEqual([
      "2",
      "1",
    ]);
    // Keys order by bytes: "Z" before "a".
    expect((await records.find(ITEMS, { source_id: "src_a" })).map((i) => i.external_id)).toEqual(["1", "Z", "a"]);
    expect((await records.find(ITEMS, {}, { orderBy: "rank" })).map((i) => i.external_id)).toEqual([
      "Z",
      "a",
      "2",
      "1",
    ]);
    expect((await records.find(ITEMS, {}, { orderBy: "rank", descending: true, limit: 2 })).map((i) => i.rank)).toEqual(
      [3, 2],
    );
    expect(await records.find(ITEMS, { rank: null })).toHaveLength(1);
    expect(await records.count(ITEMS, { source_id: ["src_a", "src_b"] })).toBe(4);
    expect(await records.count(ITEMS, { rank: [1, 2] })).toBe(2);
    await expect(records.find(ITEMS, { nope: "x" })).rejects.toThrow(RangeError);
  });

  it.skipIf(skip)("put replaces by key and delete removes", async ({ records }) => {
    await records.transaction((tx) => tx.put(ITEMS, [item("src_a", "1", 1)]));
    await records.transaction(async (tx) => {
      await tx.put(ITEMS, [{ ...item("src_a", "1"), title: "renamed" }]);
      expect((await tx.get(ITEMS, "src_a:1"))?.title).toBe("renamed"); // reads see the transaction's writes
    });
    const found = await records.get(ITEMS, "src_a:1");
    expect(found?.title).toBe("renamed");
    expect(found?.rank).toBeUndefined();
    await records.transaction((tx) => tx.delete(ITEMS, ["src_a:1"]));
    expect(await records.count(ITEMS)).toBe(0);
  });

  it.skipIf(skip)("a failed transaction leaves rows and events untouched", async ({ records, published }) => {
    const kept = claimsEvent();
    await records.transaction(async (tx) => {
      await tx.put(ITEMS, [item("src_a", "1")]);
      await tx.publish(kept);
    });
    await expect(
      records.transaction(async (tx) => {
        await tx.put(ITEMS, [item("src_a", "2")]);
        await tx.delete(ITEMS, ["src_a:1"]);
        await tx.publish(claimsEvent());
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await records.find(ITEMS)).map((i) => i.external_id)).toEqual(["1"]);
    expect(await published()).toEqual([kept.id]);
  });

  it.skipIf(skip)("firstDelivery is true once per group and event", async ({ records }) => {
    const id = newId("event");
    expect(await records.transaction((tx) => tx.firstDelivery("source-sync", id))).toBe(true);
    expect(await records.transaction((tx) => tx.firstDelivery("source-sync", id))).toBe(false);
    expect(await records.transaction((tx) => tx.firstDelivery("freshness", id))).toBe(true);
    // A rolled-back mark does not count.
    const other = newId("event");
    await expect(
      records.transaction(async (tx) => {
        await tx.firstDelivery("source-sync", other);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await records.transaction((tx) => tx.firstDelivery("source-sync", other))).toBe(true);
  });

  it.skipIf(skip)("a transaction object cannot be used after it ends", async ({ records }) => {
    let leaked: Parameters<Parameters<Records["transaction"]>[0]>[0] | undefined;
    await records.transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked?.put(ITEMS, [item("src_a", "1")])).rejects.toThrow("the transaction has ended");
  });
});

test("table definitions are checked", () => {
  expect(() => defineTable<Item>("items", { key: (i) => i.title })).toThrow(RangeError);
  expect(() => defineTable<Item>("s.items", { key: (i) => i.title, columns: { doc: (i) => i.title } })).toThrow(
    RangeError,
  );
  expect(() => defineTable<Item>("s.items", { key: (i) => i.title, types: { rank: "integer" } })).toThrow(RangeError);
});
