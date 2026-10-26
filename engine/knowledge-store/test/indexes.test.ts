// Search index plugins: the same filter semantics for pgvector and pg_search as for the
// in-memory stand-ins that other components' tests use.

import type { Chunk, IndexFilter, KeywordIndex, VectorIndex } from "@inspiration/contracts";
import { openPool, registry, withTransaction } from "@inspiration/kernel";
import { createTestDatabase, hasStack, stackTest, testData } from "@inspiration/testkit";
import { describe, expect, test as unitTest } from "vitest";
import {
  type BaseStore,
  IntegrityError,
  MemoryKeywordIndex,
  MemoryStore,
  MemoryVectorIndex,
  PgSearchIndex,
  PgVectorIndex,
  PostgresStore,
  vectorLiteral,
} from "../src/index.ts";
import { Sample } from "../src/testing.ts";
import { BACKENDS, type Backend } from "./fixtures.ts";

const ZH = testData<{
  documents: Record<"cap" | "trad" | "approval", string>;
  queries: Record<"standards" | "hotel", string>;
}>(import.meta.url, "zh.yaml");

/** Three Chinese passages, one in traditional characters, and an English one. */
const DOCS = { ...ZH.documents, revenue: "Quarterly revenue report for the sales team." };
type Doc = keyof typeof DOCS;
const SALES = "spc_01JC00000000000000000SALES";

function unit(...xs: number[]): number[] {
  const n = Math.hypot(...xs);
  return xs.map((x) => x / n);
}

function everyone(kb: Sample, overrides: Partial<IndexFilter> = {}): IndexFilter {
  return {
    space_ids: [kb.spaceId, SALES],
    principal_tokens: [`tenant:${kb.tenantId}`, "grp:sales"],
    max_sensitivity: "secret",
    ...overrides,
  };
}

interface Indexes {
  store: BaseStore;
  vector: VectorIndex;
  keyword: KeywordIndex;
}

/**
 * One chunk per DOCS entry. "approval" is confidential; "revenue" is in another space and
 * readable only by the sales group.
 */
async function seed({ store }: Indexes, kb: Sample): Promise<Record<Doc, Chunk>> {
  const [sv, spans] = kb.sourceVersion(Object.values(DOCS));
  const keys = Object.keys(DOCS) as Doc[];
  const chunks = Object.fromEntries(
    keys.map((key, i) => {
      const span = spans[i] as (typeof spans)[0];
      const overrides: Partial<Chunk> = {
        ...(key === "approval" && { sensitivity: "confidential" }),
        ...(key === "revenue" && { space_id: SALES, acl_tokens: ["grp:sales"] }),
      };
      return [key, kb.chunk(sv, [span], overrides)];
    }),
  ) as Record<Doc, Chunk>;
  const vectors = {
    [chunks.cap.id]: unit(1, 0.1, 0),
    [chunks.trad.id]: unit(0.8, 0.3, 0),
    [chunks.approval.id]: unit(0.9, 0, 0.2),
    [chunks.revenue.id]: unit(0, 0, 1),
  };
  await store.transaction(async (tx) => {
    await tx.putSourceVersion(sv, spans);
    await tx.putChunks(Object.values(chunks), vectors, { model: "fake-embedding" });
  });
  return chunks;
}

function indexTest(backend: Backend) {
  return (
    unitTest
      // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
      .extend("kb", async ({}) => new Sample())
      // biome-ignore lint/correctness/noEmptyPattern: as above
      .extend("indexes", async ({}, { onCleanup }): Promise<Indexes> => {
        if (backend === "memory") {
          const store = new MemoryStore();
          return { store, vector: new MemoryVectorIndex(store), keyword: new MemoryKeywordIndex(store) };
        }
        const db = await createTestDatabase();
        const pool = await openPool(db.url);
        onCleanup(async () => {
          await pool.end();
          await db.drop();
        });
        return { store: new PostgresStore(pool), vector: new PgVectorIndex(pool), keyword: new PgSearchIndex(pool) };
      })
      .extend("chunks", async ({ indexes, kb }) => seed(indexes, kb))
  );
}

describe.each(BACKENDS)("$backend indexes", ({ backend, skip }) => {
  const test = indexTest(backend);

  describe.skipIf(skip)("keyword", () => {
    test("BM25 matches Chinese, including traditional characters", async ({ indexes, chunks, kb }) => {
      const hits = await indexes.keyword.search(ZH.queries.standards, 10, everyone(kb));
      const ids = hits.map((h) => h.chunk_id);
      // The traditional characters of trad fold to the simplified ones of the query.
      expect(ids).toEqual(expect.arrayContaining([chunks.cap.id, chunks.trad.id]));
      expect(ids).not.toContain(chunks.revenue.id);
      expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i + 1));
      expect(hits.every((h, i) => i === 0 || (hits[i - 1]?.score ?? 0) >= h.score)).toBe(true);
      const latin = await indexes.keyword.search("revenue", 10, everyone(kb));
      expect(latin.map((h) => h.chunk_id)).toEqual([chunks.revenue.id]);
    });

    test("BM25 applies the filter before the top-k cut", async ({ indexes: { keyword }, chunks, kb }) => {
      const internal = await keyword.search(ZH.queries.hotel, 10, everyone(kb, { max_sensitivity: "internal" }));
      expect(internal.map((h) => h.chunk_id)).not.toContain(chunks.approval.id);
      const oneSpace = await keyword.search(
        `revenue ${ZH.queries.hotel}`,
        10,
        everyone(kb, { space_ids: [kb.spaceId] }),
      );
      expect(oneSpace.map((h) => h.chunk_id)).not.toContain(chunks.revenue.id);
      expect(
        await keyword.search("revenue", 10, everyone(kb, { principal_tokens: [`tenant:${kb.tenantId}`] })),
      ).toEqual([]);
      expect(await keyword.search(ZH.queries.hotel, 10, everyone(kb, { principal_tokens: [] }))).toEqual([]);
      expect(await keyword.search("  ", 10, everyone(kb))).toEqual([]);
      const top1 = await keyword.search(ZH.queries.hotel, 1, everyone(kb, { max_sensitivity: "internal" }));
      expect(top1).toHaveLength(1);
      expect(top1[0]?.chunk_id).not.toBe(chunks.approval.id);
    });
  });

  describe.skipIf(skip)("vector", () => {
    test("vector search ranks by cosine within the filter", async ({ indexes: { vector }, chunks, kb }) => {
      const hits = await vector.search(unit(1, 0.1, 0), 3, everyone(kb));
      expect(hits.map((h) => h.chunk_id)).toEqual([chunks.cap.id, chunks.approval.id, chunks.trad.id]);
      expect(hits[0]?.score).toBeCloseTo(1, 6);
      const filtered = await vector.search(unit(1, 0.1, 0), 2, everyone(kb, { max_sensitivity: "internal" }));
      expect(filtered.map((h) => h.chunk_id)).toEqual([chunks.cap.id, chunks.trad.id]);
      expect(await vector.search(unit(1, 0, 0, 0), 3, everyone(kb))).toEqual([]); // other dimensions: no match
    });

    test("vector upsert and delete", async ({ indexes: { vector }, chunks, kb }) => {
      await vector.upsert({ [chunks.revenue.id]: unit(1, 0.1, 0) }, { model: "fake-embedding" });
      const hits = await vector.search(unit(1, 0.1, 0), 2, everyone(kb));
      expect(new Set(hits.map((h) => h.chunk_id))).toEqual(new Set([chunks.cap.id, chunks.revenue.id]));
      await vector.delete([chunks.cap.id]);
      const after = await vector.search(unit(1, 0.1, 0), 5, everyone(kb));
      expect(after.map((h) => h.chunk_id)).not.toContain(chunks.cap.id);
      await expect(
        vector.upsert({ chk_01JC00000000000000000NOPE: unit(1, 0, 0) }, { model: "fake-embedding" }),
      ).rejects.toThrow(IntegrityError);
    });
  });

  describe.skipIf(skip)("both", () => {
    test("removing a chunk removes it from both indexes", async ({ indexes, chunks, kb }) => {
      await indexes.store.transaction((tx) => tx.removeChunks([chunks.cap.id]));
      const keyword = await indexes.keyword.search(ZH.queries.standards, 10, everyone(kb));
      expect(keyword.map((h) => h.chunk_id)).not.toContain(chunks.cap.id);
      const vector = await indexes.vector.search(unit(1, 0.1, 0), 10, everyone(kb));
      expect(vector.map((h) => h.chunk_id)).not.toContain(chunks.cap.id);
    });
  });
});

describe.skipIf(!hasStack())("pgvector", () => {
  stackTest("1024-dimension vectors use the HNSW path", async ({ databaseUrl }) => {
    const pool = await openPool(databaseUrl);
    try {
      const store = new PostgresStore(pool);
      const kb = new Sample();
      const [sv, spans] = kb.sourceVersion(["a", "b"]);
      const [a, b] = spans.map((s) => kb.chunk(sv, [s])) as [Chunk, Chunk];
      const basis = (i: number) => unit(...Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0)));
      const vectors = { [a.id]: basis(0), [b.id]: basis(1) };
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(sv, spans);
        await tx.putChunks([a, b], vectors, { model: "qwen3-embedding" });
      });
      const index = new PgVectorIndex(pool, { model: "qwen3-embedding" });
      expect((await index.search(basis(1), 1, everyone(kb))).map((h) => h.chunk_id)).toEqual([b.id]);
      expect(await new PgVectorIndex(pool, { model: "bge-m3" }).search(basis(1), 1, everyone(kb))).toEqual([]);
      // Two rows are cheaper to scan, so forbid that to see whether the index can serve the query at all.
      const plan = await withTransaction(pool, async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        const { rows } = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT chunk_id FROM kb.chunk_embeddings e WHERE dims = 1024
           ORDER BY e.embedding::vector(1024) <=> $1::vector(1024) LIMIT 1`,
          [vectorLiteral(basis(1))],
        );
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      });
      expect(plan).toMatch(/chunk_embeddings_hnsw_1024/);
    } finally {
      await pool.end();
    }
  });
});

unitTest("index plugins are registered", () => {
  expect(registry("vector_indexes").names()).toEqual(expect.arrayContaining(["pgvector", "memory"]));
  expect(registry("keyword_indexes").names()).toEqual(expect.arrayContaining(["pg_search", "memory"]));
});
