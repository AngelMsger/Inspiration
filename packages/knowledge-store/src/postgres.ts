/**
 * Postgres KnowledgeStore. Events published in a transaction go to the outbox in the same
 * transaction, so they commit (or roll back) with the data.
 *
 * Batch writes send their rows as one JSON parameter and expand it with jsonb_to_recordset,
 * so a write is one statement however many rows it has. IDs are ordered with COLLATE "C"
 * (byte order), which is the order the in-memory store returns.
 */

import {
  type AclSnapshot,
  type Chunk,
  type Claim,
  type ClaimDerivation,
  type ClaimEvidence,
  type ClaimQuery,
  type DependencyEdge,
  type EventEnvelope,
  type PageSnapshot,
  type PageVersionInfo,
  rank,
  type SourceBlock,
  type SourceVersion,
  type Span,
  type StoreTx,
} from "@inspiration/contracts";
import { writeOutbox } from "@inspiration/eventbus";
import { type Pool, type PoolClient, type Queryable, withTransaction } from "@inspiration/kernel";
import pg from "pg";
import { BaseStore, type StoreOptions } from "./base.ts";
import { QUERY_LIMIT, toSql } from "./query.ts";
import * as rules from "./rules.ts";

// Constraint violations that mean the write broke a rule rather than that the database failed.
const INTEGRITY_CODES = new Set(["23503", "23505", "23514"]); // foreign key, unique, check

/** What BM25 indexes: the contextual header and heading path situate the chunk text. */
export function searchText(c: Chunk): string {
  return [c.contextual_header, (c.heading_path ?? []).join(" / "), c.text].filter(Boolean).join("\n");
}

export function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

/** Upsert embeddings of stored chunks. Unknown chunk IDs raise IntegrityError. */
export async function writeEmbeddings(
  client: Queryable,
  items: Readonly<Record<string, readonly number[]>>,
  model: string,
): Promise<void> {
  rules.checkEmbeddings(items, model);
  const rows = Object.entries(items).map(([chunk_id, v]) => ({
    chunk_id,
    dims: v.length,
    embedding: vectorLiteral(v),
  }));
  if (!rows.length) return;
  try {
    await client.query(
      `INSERT INTO kb.chunk_embeddings (chunk_id, model, dims, embedding)
       SELECT r.chunk_id, $2, r.dims, r.embedding::vector
       FROM jsonb_to_recordset($1::jsonb) AS r(chunk_id text, dims integer, embedding text)
       ON CONFLICT (chunk_id) DO UPDATE
         SET model = excluded.model, dims = excluded.dims, embedding = excluded.embedding`,
      [JSON.stringify(rows), model],
    );
  } catch (e) {
    if (e instanceof pg.DatabaseError && e.code === "23503") {
      throw new rules.IntegrityError("embeddings for unknown chunks", { cause: e });
    }
    throw e;
  }
}

async function writeSpans(client: Queryable, spans: readonly Span[]): Promise<void> {
  if (!spans.length) return;
  const rows = spans.map((s) => ({
    id: s.id,
    tenant_id: s.tenant_id,
    source_version_id: s.source_version_id,
    ordinal: s.ordinal,
    text: s.text,
    doc: s,
  }));
  await client.query(
    `INSERT INTO kb.spans (id, tenant_id, source_version_id, ordinal, text, doc)
     SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS r(id text, tenant_id text, source_version_id text, ordinal integer, text text, doc jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rows)],
  );
}

async function docs<T>(client: Queryable, sql: string, params: unknown[]): Promise<T[]> {
  const { rows } = await client.query<{ doc: T }>(sql, params);
  return rows.map((r) => r.doc);
}

/** Rows in the order of ids, skipping unknown ones. */
function inOrder<T>(found: readonly T[], idOf: (row: T) => string, ids: readonly string[]): T[] {
  const byId = new Map(found.map((row) => [idOf(row), row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export class PgTx implements StoreTx {
  readonly #store: PostgresStore;
  readonly #client: PoolClient;
  #open = true;

  constructor(store: PostgresStore, client: PoolClient) {
    this.#store = store;
    this.#client = client;
  }

  close(): void {
    this.#open = false;
  }

  /** The transaction's connection. It goes back to the pool when the transaction ends. */
  #db(): PoolClient {
    if (!this.#open) throw new Error("the transaction has ended");
    return this.#client;
  }

  async putSourceVersion(version: SourceVersion, spans: readonly Span[] = []): Promise<void> {
    const db = this.#db();
    rules.checkSourceVersion(version, spans);
    await db.query(
      `INSERT INTO kb.source_versions
         (id, tenant_id, source_id, space_id, external_id, fetched_at, deleted, sensitivity, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [
        version.id,
        version.tenant_id,
        version.source_id,
        version.space_id,
        version.external_id,
        version.fetched_at,
        Boolean(version.deleted),
        version.sensitivity,
        JSON.stringify(version),
      ],
    );
    await writeSpans(db, spans);
  }

  async putBlocks(sourceVersionId: string, blocks: readonly SourceBlock[], spans: readonly Span[]): Promise<void> {
    const db = this.#db();
    const [version] = await docs<SourceVersion>(db, "SELECT doc FROM kb.source_versions WHERE id = $1", [
      sourceVersionId,
    ]);
    const { rows: stored } = await db.query<{ id: string }>("SELECT id FROM kb.spans WHERE id = ANY($1)", [
      [...new Set(blocks.flatMap((b) => b.span_ids))],
    ]);
    rules.checkBlocks(version, sourceVersionId, blocks, spans, new Set(stored.map((r) => r.id)));
    // Serialize writers of one version, so a redelivered event cannot interleave with the first.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kb.blocks:' || $1))", [sourceVersionId]);
    const { rowCount } = await db.query("SELECT 1 FROM kb.blocks WHERE source_version_id = $1 LIMIT 1", [
      sourceVersionId,
    ]);
    if (rowCount) return;
    await writeSpans(db, spans);
    if (!blocks.length) return;
    const rows = blocks.map((b) => ({
      source_version_id: b.source_version_id,
      id: b.id,
      tenant_id: b.tenant_id,
      ordinal: b.ordinal,
      span_ids: b.span_ids,
      doc: b,
    }));
    await db.query(
      `INSERT INTO kb.blocks (source_version_id, id, tenant_id, ordinal, span_ids, doc)
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r(source_version_id text, id text, tenant_id text, ordinal integer, span_ids text[], doc jsonb)`,
      [JSON.stringify(rows)],
    );
  }

  async putChunks(
    chunks: readonly Chunk[],
    embeddings?: Readonly<Record<string, readonly number[]>>,
    options: { model?: string } = {},
  ): Promise<void> {
    const db = this.#db();
    const versionIds = [...new Set(chunks.map((c) => c.source_version_id))];
    const { rows: found } = await db.query<{ id: string }>("SELECT id FROM kb.source_versions WHERE id = ANY($1)", [
      versionIds,
    ]);
    rules.checkChunks(chunks, new Set(found.map((r) => r.id)), embeddings, options.model);
    if (chunks.length) {
      const rows = chunks.map((c) => ({
        id: c.id,
        tenant_id: c.tenant_id,
        source_version_id: c.source_version_id,
        space_id: c.space_id,
        ordinal: c.ordinal,
        search_text: searchText(c),
        sensitivity_rank: rank(c.sensitivity),
        acl_tokens: c.acl_tokens ?? [],
        doc: c,
      }));
      await db.query(
        `INSERT INTO kb.chunks
           (id, tenant_id, source_version_id, space_id, ordinal, search_text, sensitivity_rank, acl_tokens, doc)
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS r(id text, tenant_id text, source_version_id text, space_id text, ordinal integer, search_text text,
                sensitivity_rank smallint, acl_tokens text[], doc jsonb)
         ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, ordinal = excluded.ordinal,
           search_text = excluded.search_text, sensitivity_rank = excluded.sensitivity_rank,
           acl_tokens = excluded.acl_tokens, doc = excluded.doc`,
        [JSON.stringify(rows)],
      );
    }
    if (embeddings && options.model) await writeEmbeddings(db, embeddings, options.model);
  }

  async removeChunks(chunkIds: readonly string[]): Promise<void> {
    await this.#db().query("DELETE FROM kb.chunks WHERE id = ANY($1)", [chunkIds]);
  }

  async upsertClaims(
    claims: readonly Claim[],
    evidence: readonly ClaimEvidence[],
    derivations: readonly ClaimDerivation[] = [],
  ): Promise<string[]> {
    const db = this.#db();
    const referenced = [
      ...new Set([
        ...claims.map((c) => c.id),
        ...evidence.map((e) => e.claim_id),
        ...derivations.flatMap((d) => [d.claim_id, ...d.from_claim_ids]),
      ]),
    ];
    const batch = claims.map((c) => c.id);
    const { rows: existing } = await db.query<{ id: string }>("SELECT id FROM kb.claims WHERE id = ANY($1)", [
      referenced,
    ]);
    const { rows: supported } = await db.query<{ claim_id: string }>(
      `SELECT claim_id FROM kb.claim_evidence WHERE claim_id = ANY($1) AND role = 'supports'
       UNION SELECT claim_id FROM kb.claim_derivations WHERE claim_id = ANY($1)`,
      [batch],
    );
    rules.checkClaims(claims, evidence, derivations, {
      existing: new Set(existing.map((r) => r.id)),
      alreadySupported: new Set(supported.map((r) => r.claim_id)),
    });
    const spanIds = [...new Set(evidence.map((e) => e.span_id))];
    const spans = new Map(
      (await docs<Span>(db, "SELECT doc FROM kb.spans WHERE id = ANY($1)", [spanIds])).map((s) => [s.id, s]),
    );
    for (const e of evidence) rules.checkEvidence(e, spans.get(e.span_id));

    if (claims.length) {
      const rows = claims.map((c) => ({
        id: c.id,
        tenant_id: c.tenant_id,
        space_id: c.space_id,
        status: c.status,
        knowledge_class: c.knowledge_class,
        subject_entity_id: c.subject_entity_id ?? null,
        predicate: c.predicate ?? null,
        valid_from: c.valid_time.start ?? null,
        valid_to: c.valid_time.end ?? null,
        recorded_at: c.recorded_at,
        superseded_at: c.superseded_at ?? null,
        superseded_by: c.superseded_by ?? null,
        sensitivity: c.sensitivity,
        doc: c,
      }));
      await db.query(
        `INSERT INTO kb.claims
           (id, tenant_id, space_id, status, knowledge_class, subject_entity_id, predicate, valid_from, valid_to,
            recorded_at, superseded_at, superseded_by, sensitivity, doc)
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS r(id text, tenant_id text, space_id text, status text, knowledge_class text, subject_entity_id text,
                predicate text, valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz,
                superseded_at timestamptz, superseded_by text, sensitivity text, doc jsonb)
         ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, status = excluded.status,
           knowledge_class = excluded.knowledge_class, subject_entity_id = excluded.subject_entity_id,
           predicate = excluded.predicate, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
           recorded_at = excluded.recorded_at, superseded_at = excluded.superseded_at,
           superseded_by = excluded.superseded_by, sensitivity = excluded.sensitivity, doc = excluded.doc`,
        [JSON.stringify(rows)],
      );
    }
    if (derivations.length) {
      await db.query(
        `INSERT INTO kb.claim_derivations (claim_id, from_claim_ids, method)
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(claim_id text, from_claim_ids text[], method text)
         ON CONFLICT (claim_id) DO UPDATE SET from_claim_ids = excluded.from_claim_ids, method = excluded.method`,
        [JSON.stringify(derivations)],
      );
    }
    if (evidence.length) {
      const rows = evidence.map((e) => ({
        claim_id: e.claim_id,
        span_id: e.span_id,
        source_version_id: e.source_version_id,
        role: e.role,
        doc: e,
      }));
      await db.query(
        `INSERT INTO kb.claim_evidence (claim_id, span_id, source_version_id, role, doc)
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS r(claim_id text, span_id text, source_version_id text, role text, doc jsonb)
         ON CONFLICT (claim_id, span_id, role) DO UPDATE SET doc = excluded.doc`,
        [JSON.stringify(rows)],
      );
    }
    return batch;
  }

  async supersede(claimId: string, by: string, reason: string): Promise<void> {
    const db = this.#db();
    const found = new Map(
      (await docs<Claim>(db, "SELECT doc FROM kb.claims WHERE id = ANY($1) FOR UPDATE", [[claimId, by]])).map((c) => [
        c.id,
        c,
      ]),
    );
    const old = found.get(claimId);
    rules.checkSupersede(old, found.get(by), claimId, by);
    const now = this.#store.clock().toISOString();
    const updated: Claim = { ...old, superseded_at: now, superseded_by: by, status: "superseded", updated_at: now };
    await db.query(
      `UPDATE kb.claims SET superseded_at = $1, superseded_by = $2, status = 'superseded', supersede_reason = $3,
         doc = $4 WHERE id = $5`,
      [now, by, reason, JSON.stringify(updated), claimId],
    );
  }

  async recordDependencies(edges: readonly DependencyEdge[]): Promise<void> {
    const db = this.#db();
    const artifacts = [...new Set(edges.map((e) => e.artifact_id))];
    await db.query("DELETE FROM kb.dependencies WHERE artifact_id = ANY($1)", [artifacts]);
    if (!edges.length) return;
    await db.query(
      `INSERT INTO kb.dependencies (artifact_id, input_id, input_hash)
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(artifact_id text, input_id text, input_hash text)`,
      [JSON.stringify(edges)],
    );
  }

  async putPageSnapshot(snapshot: PageSnapshot): Promise<void> {
    const db = this.#db();
    // Serialize writers of one page so two renders cannot both claim the next version.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kb.page:' || $1))", [snapshot.page_id]);
    const { rows } = await db.query<{ v: number | null }>(
      "SELECT max(version) AS v FROM kb.page_snapshots WHERE page_id = $1",
      [snapshot.page_id],
    );
    rules.checkPageSnapshot(snapshot, rows[0]?.v ?? undefined);
    const spec = snapshot.spec;
    await db.query(
      `INSERT INTO kb.page_snapshots (page_id, version, tenant_id, space_id, inputs_hash, created_at, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshot.page_id,
        snapshot.version,
        spec.tenant_id,
        spec.space_id,
        spec.inputs_hash,
        snapshot.created_at,
        JSON.stringify(snapshot),
      ],
    );
  }

  async putAclSnapshot(snapshot: AclSnapshot): Promise<void> {
    await this.#db().query(
      `INSERT INTO kb.acl_snapshots (source_id, external_id, acl_hash, captured_at, doc)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [snapshot.source_id, snapshot.external_id, snapshot.acl_hash, snapshot.captured_at, JSON.stringify(snapshot)],
    );
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    await writeOutbox(this.#db(), events);
  }
}

export class PostgresStore extends BaseStore {
  readonly pool: Pool;

  constructor(pool: Pool, options: StoreOptions = {}) {
    super(options);
    this.pool = pool;
  }

  async transaction<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const tx = new PgTx(this, client);
        try {
          return await fn(tx);
        } finally {
          tx.close();
        }
      });
    } catch (e) {
      if (e instanceof pg.DatabaseError && e.code && INTEGRITY_CODES.has(e.code)) {
        throw new rules.IntegrityError(e.message.split("\n")[0] ?? e.message, { cause: e });
      }
      throw e;
    }
  }

  #docs<T>(sql: string, params: unknown[]): Promise<T[]> {
    return docs<T>(this.pool, sql, params);
  }

  // ---------------------------------------------------------- reads

  async getSourceVersion(versionId: string): Promise<SourceVersion | undefined> {
    return (await this.#docs<SourceVersion>("SELECT doc FROM kb.source_versions WHERE id = $1", [versionId]))[0];
  }

  async latestSourceVersion(sourceId: string, externalId: string): Promise<SourceVersion | undefined> {
    const found = await this.#docs<SourceVersion>(
      `SELECT doc FROM kb.source_versions WHERE source_id = $1 AND external_id = $2
       ORDER BY fetched_at DESC, id COLLATE "C" DESC LIMIT 1`,
      [sourceId, externalId],
    );
    return found[0];
  }

  async getSpans(spanIds: readonly string[]): Promise<Span[]> {
    const found = await this.#docs<Span>("SELECT doc FROM kb.spans WHERE id = ANY($1)", [spanIds]);
    return inOrder(found, (s) => s.id, spanIds);
  }

  async spansOf(sourceVersionId: string): Promise<Span[]> {
    const { rows } = await this.pool.query<{ ids: string[] | null }>(
      "SELECT array_agg(s ORDER BY b.ordinal, i) AS ids FROM kb.blocks b, unnest(b.span_ids) WITH ORDINALITY AS u(s, i) WHERE b.source_version_id = $1",
      [sourceVersionId],
    );
    const ids = rows[0]?.ids;
    if (ids?.length) return this.getSpans(ids);
    const { rowCount } = await this.pool.query("SELECT 1 FROM kb.blocks WHERE source_version_id = $1 LIMIT 1", [
      sourceVersionId,
    ]);
    if (rowCount) return [];
    return this.#docs("SELECT doc FROM kb.spans WHERE source_version_id = $1 ORDER BY ordinal", [sourceVersionId]);
  }

  async blocksOf(sourceVersionId: string): Promise<SourceBlock[]> {
    return this.#docs("SELECT doc FROM kb.blocks WHERE source_version_id = $1 ORDER BY ordinal", [sourceVersionId]);
  }

  async getChunks(chunkIds: readonly string[]): Promise<Chunk[]> {
    const found = await this.#docs<Chunk>("SELECT doc FROM kb.chunks WHERE id = ANY($1)", [chunkIds]);
    return inOrder(found, (c) => c.id, chunkIds);
  }

  async chunksOf(sourceVersionId: string): Promise<Chunk[]> {
    return this.#docs("SELECT doc FROM kb.chunks WHERE source_version_id = $1 ORDER BY ordinal", [sourceVersionId]);
  }

  async getClaims(claimIds: readonly string[]): Promise<Claim[]> {
    const found = await this.#docs<Claim>("SELECT doc FROM kb.claims WHERE id = ANY($1)", [claimIds]);
    return inOrder(found, (c) => c.id, claimIds);
  }

  async evidenceOf(claimIds: readonly string[]): Promise<ClaimEvidence[]> {
    return this.#docs(
      `SELECT doc FROM kb.claim_evidence WHERE claim_id = ANY($1)
       ORDER BY claim_id COLLATE "C", span_id COLLATE "C", role COLLATE "C"`,
      [claimIds],
    );
  }

  async claimsCiting(spanIds: readonly string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ claim_id: string }>(
      `SELECT DISTINCT claim_id COLLATE "C" AS claim_id FROM kb.claim_evidence WHERE span_id = ANY($1)
       ORDER BY 1`,
      [spanIds],
    );
    return rows.map((r) => r.claim_id);
  }

  async asOf(query: ClaimQuery, options: { validAt?: Date; knownAt?: Date } = {}): Promise<Claim[]> {
    const { where, params } = toSql(query, { validAt: options.validAt, knownAt: options.knownAt ?? this.clock() });
    return this.#docs(
      `SELECT c.doc FROM kb.claims c WHERE ${where}
       ORDER BY c.recorded_at, c.id COLLATE "C" LIMIT $${params.length + 1}`,
      [...params, query.limit || QUERY_LIMIT],
    );
  }

  async dependents(artifactIds: readonly string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ artifact_id: string }>(
      `SELECT DISTINCT artifact_id COLLATE "C" AS artifact_id FROM kb.dependencies WHERE input_id = ANY($1)
       ORDER BY 1`,
      [artifactIds],
    );
    return rows.map((r) => r.artifact_id);
  }

  async derivationsOf(claimIds: readonly string[]): Promise<ClaimDerivation[]> {
    const { rows } = await this.pool.query<ClaimDerivation>(
      "SELECT claim_id, from_claim_ids, method FROM kb.claim_derivations WHERE claim_id = ANY($1)",
      [claimIds],
    );
    return inOrder(rows, (d) => d.claim_id, claimIds);
  }

  async inputsOf(artifactIds: readonly string[]): Promise<DependencyEdge[]> {
    const { rows } = await this.pool.query<DependencyEdge>(
      `SELECT artifact_id, input_id, input_hash FROM kb.dependencies WHERE artifact_id = ANY($1)
       ORDER BY artifact_id COLLATE "C", input_id COLLATE "C"`,
      [artifactIds],
    );
    return rows;
  }

  async getPage(pageId: string, version?: number): Promise<PageSnapshot | undefined> {
    const found =
      version === undefined
        ? await this.#docs<PageSnapshot>(
            "SELECT doc FROM kb.page_snapshots WHERE page_id = $1 ORDER BY version DESC LIMIT 1",
            [pageId],
          )
        : await this.#docs<PageSnapshot>("SELECT doc FROM kb.page_snapshots WHERE page_id = $1 AND version = $2", [
            pageId,
            version,
          ]);
    return found[0];
  }

  async pageHistory(pageId: string): Promise<PageVersionInfo[]> {
    return this.#docs(
      `SELECT jsonb_strip_nulls(jsonb_build_object(
         'page_id', page_id, 'version', version, 'inputs_hash', inputs_hash, 'cause', doc->'cause',
         'change_summary', doc->'change_summary', 'created_at', doc->'created_at')) AS doc
       FROM kb.page_snapshots WHERE page_id = $1 ORDER BY version`,
      [pageId],
    );
  }

  async getAclSnapshot(sourceId: string, externalId: string, aclHash?: string): Promise<AclSnapshot | undefined> {
    const found =
      aclHash === undefined
        ? await this.#docs<AclSnapshot>(
            `SELECT doc FROM kb.acl_snapshots WHERE source_id = $1 AND external_id = $2
             ORDER BY captured_at DESC, acl_hash COLLATE "C" DESC LIMIT 1`,
            [sourceId, externalId],
          )
        : await this.#docs<AclSnapshot>(
            "SELECT doc FROM kb.acl_snapshots WHERE source_id = $1 AND external_id = $2 AND acl_hash = $3",
            [sourceId, externalId, aclHash],
          );
    return found[0];
  }
}
