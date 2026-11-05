/**
 * Search index plugins over kb.chunks. Every search applies the IndexFilter inside the index
 * query (space, ACL token overlap, sensitivity), so top-k is taken over rows the viewer may
 * see. Retrieval still re-checks results before they leave the server.
 */

import {
  type Chunk,
  type IndexFilter,
  type IndexHit,
  type KeywordIndex,
  rank,
  type VectorIndex,
} from "@inspiration/contracts";
import { type Pool, withTransaction } from "@inspiration/kernel";
import type { MemoryStore } from "./memory.ts";
import { searchText, vectorLiteral, writeEmbeddings } from "./postgres.ts";

/** The size the partial HNSW index in 0001_kb.sql covers. */
export const HNSW_DIMS = 1024;

/**
 * Scores closer than this, relative to the larger one and to 1, are one score. pgvector's
 * float4 sums leave noise in the last digits, and differently on each CPU.
 */
const SAME_SCORE = 1e-6;

const same = (a: number, b: number) => Math.abs(a - b) <= SAME_SCORE * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Rows a database query reads past k. A database returns tied rows in no fixed order, so a
 * query cut at k would keep whichever of a tie at the k-th row it met first; reading further
 * lets hits keep the whole tie.
 */
const TIES = 10;

/**
 * The k best, best first, and every hit tied with the k-th. Hits with one score share the
 * rank of the first of them, so a fusion of ranks gives ties the same weight, whichever order
 * they come in, and a question finds the same chunks each time.
 */
function hits(scored: readonly [string, number][], k: number): IndexHit[] {
  const sorted = [...scored].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  const best: IndexHit[] = [];
  let rank = 1;
  for (const [i, [chunk_id, score]] of sorted.entries()) {
    const before = sorted[i - 1];
    if (before && !same(before[1], score)) rank = i + 1;
    if (rank > k) break;
    best.push({ chunk_id, score, rank });
  }
  return best;
}

const empty = (filter: IndexFilter) => !filter.space_ids.length || !filter.principal_tokens.length;

/**
 * pgvector over kb.chunk_embeddings, cosine similarity. Pass model to keep searches from
 * mixing vectors of different embedding models.
 */
export class PgVectorIndex implements VectorIndex {
  readonly name = "pgvector";
  readonly pool: Pool;
  readonly model: string | undefined;
  readonly efSearch: number;

  constructor(pool: Pool, options: { model?: string; efSearch?: number } = {}) {
    this.pool = pool;
    this.model = options.model;
    this.efSearch = Math.trunc(options.efSearch ?? 100);
  }

  async upsert(items: Readonly<Record<string, readonly number[]>>, options: { model: string }): Promise<void> {
    await withTransaction(this.pool, (client) => writeEmbeddings(client, items, options.model));
  }

  async delete(chunkIds: readonly string[]): Promise<void> {
    await this.pool.query("DELETE FROM kb.chunk_embeddings WHERE chunk_id = ANY($1)", [chunkIds]);
  }

  async search(vector: readonly number[], k: number, filter: IndexFilter): Promise<IndexHit[]> {
    if (empty(filter) || !vector.length) return [];
    // The cast must match the partial index expression for the planner to use HNSW.
    const hnsw = vector.length === HNSW_DIMS;
    const expr = hnsw ? `e.embedding::vector(${HNSW_DIMS})` : "e.embedding";
    const cast = hnsw ? `::vector(${HNSW_DIMS})` : "::vector";
    const params: unknown[] = [
      vectorLiteral(vector),
      vector.length,
      filter.space_ids,
      filter.principal_tokens,
      rank(filter.max_sensitivity),
      k + TIES,
    ];
    const where = ["e.dims = $2", "c.space_id = ANY($3)", "c.acl_tokens && $4", "c.sensitivity_rank <= $5"];
    if (this.model) {
      params.push(this.model);
      where.push(`e.model = $${params.length}`);
    }
    const sql = `SELECT c.id, 1 - (${expr} <=> $1${cast}) AS score
                 FROM kb.chunk_embeddings e JOIN kb.chunks c ON c.id = e.chunk_id
                 WHERE ${where.join(" AND ")}
                 ORDER BY ${expr} <=> $1${cast} LIMIT $6`;
    const rows = await withTransaction(this.pool, async (client) => {
      // Keep scanning the HNSW graph until k rows pass the filter (pgvector 0.8).
      await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      await client.query(`SET LOCAL hnsw.ef_search = ${this.efSearch}`);
      return (await client.query<{ id: string; score: number }>(sql, params)).rows;
    });
    return hits(
      rows.map((r) => [r.id, Number(r.score)]),
      k,
    );
  }
}

/** BM25 over kb.chunks.search_text through ParadeDB pg_search with the jieba tokenizer. */
export class PgSearchIndex implements KeywordIndex {
  readonly name = "pg_search";
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async search(text: string, k: number, filter: IndexFilter): Promise<IndexHit[]> {
    if (empty(filter) || !text.trim()) return [];
    const { rows } = await this.pool.query<{ id: string; score: number }>(
      `SELECT id, pdb.score(id) AS score FROM kb.chunks
       WHERE search_text ||| $1 AND space_id = ANY($2) AND sensitivity_rank <= $3 AND acl_tokens && $4
       ORDER BY pdb.score(id) DESC LIMIT $5`,
      [text, filter.space_ids, rank(filter.max_sensitivity), filter.principal_tokens, k + TIES],
    );
    return hits(
      rows.map((r) => [r.id, Number(r.score)]),
      k,
    );
  }
}

// ---------------------------------------------------------------- in memory

function visible(c: Chunk, filter: IndexFilter): boolean {
  const tokens = new Set(filter.principal_tokens);
  return (
    filter.space_ids.includes(c.space_id) &&
    (c.acl_tokens ?? []).some((t) => tokens.has(t)) &&
    rank(c.sensitivity) <= rank(filter.max_sensitivity)
  );
}

const WORD = /[0-9a-z]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** Latin words plus unigrams and bigrams of Han and kana characters: a crude stand-in for jieba. */
export function terms(text: string): string[] {
  const tokens = text.toLowerCase().match(WORD) ?? [];
  const cjk = tokens.filter((t) => CJK.test(t));
  return [...tokens, ...cjk.slice(1).map((t, i) => `${cjk[i]}${t}`)];
}

function norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
}

export class MemoryVectorIndex implements VectorIndex {
  readonly name = "memory";
  readonly store: MemoryStore;
  readonly model: string | undefined;

  constructor(store: MemoryStore, options: { model?: string } = {}) {
    this.store = store;
    this.model = options.model;
  }

  async upsert(items: Readonly<Record<string, readonly number[]>>, options: { model: string }): Promise<void> {
    await this.store.transaction((tx) => tx.putEmbeddings(items, options));
  }

  async delete(chunkIds: readonly string[]): Promise<void> {
    await this.store.transaction((tx) => tx.removeEmbeddings(chunkIds));
  }

  async search(vector: readonly number[], k: number, filter: IndexFilter): Promise<IndexHit[]> {
    const qn = norm(vector);
    const chunks = new Map([...this.store.storedChunks()].map((c) => [c.id, c]));
    const scored: [string, number][] = [];
    for (const [chunkId, { model, vector: v }] of this.store.storedEmbeddings()) {
      const chunk = chunks.get(chunkId);
      if (!chunk || v.length !== vector.length || !visible(chunk, filter)) continue;
      if (this.model && model !== this.model) continue;
      const dot = v.reduce((sum, x, i) => sum + x * (vector[i] as number), 0);
      scored.push([chunkId, dot / (qn * norm(v))]);
    }
    return hits(scored, k);
  }
}

/** BM25 (k1 = 1.2, b = 0.75) over the same search text Postgres indexes. */
export class MemoryKeywordIndex implements KeywordIndex {
  readonly name = "memory";
  readonly store: MemoryStore;
  /** Term counts by chunk. The store replaces a chunk it writes again and never changes one, so none goes stale. */
  readonly #counts = new WeakMap<Chunk, Map<string, number>>();

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async search(text: string, k: number, filter: IndexFilter): Promise<IndexHit[]> {
    const query = new Set(terms(text));
    if (!query.size) return [];
    const docs = new Map<string, Map<string, number>>();
    for (const c of this.store.storedChunks()) {
      if (!visible(c, filter)) continue;
      let tf = this.#counts.get(c);
      if (!tf) {
        tf = new Map<string, number>();
        for (const t of terms(searchText(c))) tf.set(t, (tf.get(t) ?? 0) + 1);
        this.#counts.set(c, tf);
      }
      docs.set(c.id, tf);
    }
    if (!docs.size) return [];
    const lengths = new Map([...docs].map(([id, tf]) => [id, [...tf.values()].reduce((a, b) => a + b, 0)]));
    const avg = [...lengths.values()].reduce((a, b) => a + b, 0) / docs.size;
    const df = new Map([...query].map((t) => [t, [...docs.values()].filter((d) => d.has(t)).length]));
    const scored: [string, number][] = [];
    for (const [chunkId, tf] of docs) {
      const length = lengths.get(chunkId) ?? 0;
      let score = 0;
      for (const t of query) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.size - n + 0.5) / (n + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * length) / avg));
      }
      if (score > 0) scored.push([chunkId, score]);
    }
    return hits(scored, k);
  }
}
