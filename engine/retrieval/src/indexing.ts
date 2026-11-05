// Indexing: each document's latest version cut into chunks with a contextual header and an
// embedding, and the editions normalization pairs it with. Retrieval's doc comment (index.ts)
// describes the behaviour; search and answers read what this writes.

import { chunkTokens } from "@inspiration/access-control";
import type {
  Chunk,
  DuplicateDocument,
  EventEnvelope,
  EventHandler,
  KnowledgeStore,
  ModelGateway,
  SourceVersion,
} from "@inspiration/contracts";
import { payloadOf } from "@inspiration/contracts";
import { defineTable, type Records, type RecordTx } from "@inspiration/eventbus";
import { searchText } from "@inspiration/knowledge-store";
import type { PromptRegistry } from "@inspiration/model-gateway";
import { type ChunkDraft, chunk } from "./chunks.ts";
import {
  COMPONENT,
  CONTEXT_CHARS,
  CONTEXT_PROMPT_VERSION,
  CONTEXT_SCHEMA,
  CONTEXT_TASK,
  CONTEXTS_PER_CALL,
  type ContextInput,
  type ContextOutput,
  complete,
} from "./protocol.ts";

/** Texts per embedding call. */
export const EMBED_BATCH = 64;

/** A document retrieval has indexed, and the chunks of the version it indexed. */
export interface IndexedDocument {
  tenant_id: string;
  /** source_id:external_id */
  document: string;
  source_version_id: string;
  /** When that version was fetched; an older version that arrives late changes nothing. */
  fetched_at: string;
  chunk_ids: string[];
  deleted?: true;
}

export const key = (tenantId: string, id: string) => `${tenantId}|${id}`;

export const documentOf = (v: { source_id: string; external_id: string }) => `${v.source_id}:${v.external_id}`;

export const DOCUMENTS = defineTable<IndexedDocument>("retrieval.documents", {
  key: (d) => key(d.tenant_id, d.document),
  columns: { tenant_id: (d) => d.tenant_id },
});

/** Two documents that are editions of one text, as normalization reported them; stored each way. */
export interface Edition {
  tenant_id: string;
  /** source_id:external_id */
  document: string;
  other: string;
  /** The versions compared, the document's and the other's; a row of other versions is stale. */
  versions: [string, string];
  /** The document whose report named the pair. */
  by: string;
}

export const EDITIONS = defineTable<Edition>("retrieval.editions", {
  key: (e) => `${key(e.tenant_id, e.document)}|${e.other}`,
  columns: { tenant_id: (e) => e.tenant_id, document: (e) => e.document },
});

/** What indexing counts, in Retrieval.totals. */
export interface IndexTotals {
  indexed: number;
  chunks: number;
  embedded: number;
}

export class Indexer {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly models: ModelGateway;
  readonly prompts: PromptRegistry;
  readonly totals: IndexTotals;
  /** Index writes of one tenant run one at a time: they read and replace a document's record. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: {
    store: KnowledgeStore;
    records: Records;
    models: ModelGateway;
    prompts: PromptRegistry;
    totals: IndexTotals;
  }) {
    this.store = options.store;
    this.records = options.records;
    this.models = options.models;
    this.prompts = options.prompts;
    this.totals = options.totals;
  }

  readonly onBlocksChanged: EventHandler = async (event: EventEnvelope) => {
    await this.#serial(event.tenant_id, () => this.#index(event));
  };

  async #index(event: EventEnvelope): Promise<void> {
    const change = payloadOf(event, "blocks.changed");
    const version = await this.store.getSourceVersion(change.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${change.source_version_id}`);
    const document = documentOf(version);
    const state = await this.records.get(DOCUMENTS, key(version.tenant_id, document));
    // Already indexed, or a late event of an older version than the one indexed.
    if (state && (state.source_version_id === version.id || state.fetched_at > version.fetched_at)) return;
    const old = state?.chunk_ids.length ? await this.store.getChunks(state.chunk_ids) : [];
    const record: IndexedDocument = {
      tenant_id: version.tenant_id,
      document,
      source_version_id: version.id,
      fetched_at: version.fetched_at,
      chunk_ids: [],
    };
    if (change.deleted || version.deleted) {
      if (old.length) await this.store.transaction((tx) => tx.removeChunks(old.map((c) => c.id)));
      await this.records.transaction(async (tx) => {
        await tx.put(DOCUMENTS, [{ ...record, deleted: true }]);
        await this.#editions(tx, version, []);
      });
      return;
    }
    const spans = new Map((await this.store.spansOf(version.id)).map((s) => [s.id, s]));
    const drafts = chunk(
      { tenantId: version.tenant_id, sourceId: version.source_id, externalId: version.external_id },
      await this.store.blocksOf(version.id),
      spans,
    );
    const before = new Map(old.map((c) => [c.id, c]));
    const fresh = drafts.filter((d) => !before.has(d.id));
    const headers = await this.#headers(version, fresh);
    const tokens = chunkTokens(version.tenant_id);
    const chunks = drafts.map((d): Chunk => {
      const header = before.get(d.id)?.contextual_header ?? headers.get(d.id);
      return {
        id: d.id,
        tenant_id: version.tenant_id,
        source_version_id: version.id,
        space_id: version.space_id,
        ordinal: d.ordinal,
        span_ids: d.span_ids,
        ...(d.heading_path.length && { heading_path: d.heading_path }),
        ...(header && { contextual_header: header }),
        text: d.text,
        token_count: d.token_count,
        content_hash: d.content_hash,
        sensitivity: version.sensitivity,
        acl_tokens: tokens,
      };
    });
    const embedded = await this.#embed(
      version,
      chunks.filter((c) => !before.has(c.id)),
    );
    const kept = new Set(chunks.map((c) => c.id));
    await this.store.transaction(async (tx) => {
      const gone = old.filter((c) => !kept.has(c.id)).map((c) => c.id);
      if (gone.length) await tx.removeChunks(gone);
      if (chunks.length) await tx.putChunks(chunks, embedded?.vectors, embedded && { model: embedded.model });
    });
    await this.records.transaction(async (tx) => {
      await tx.put(DOCUMENTS, [{ ...record, chunk_ids: chunks.map((c) => c.id) }]);
      await this.#editions(tx, version, change.duplicates ?? []);
    });
    this.totals.indexed++;
    this.totals.chunks += chunks.length;
    this.totals.embedded += Object.keys(embedded?.vectors ?? {}).length;
  }

  /**
   * The document's editions as its version's report names them, each way. The pairs it named
   * before and no longer does go, and so do the pairs other documents named against an earlier
   * version of it; pairs they named against this one stay, whichever report came first.
   */
  async #editions(tx: RecordTx, version: SourceVersion, reported: readonly DuplicateDocument[]): Promise<void> {
    const tenantId = version.tenant_id;
    const document = documentOf(version);
    const named = new Map(reported.map((d) => [`${d.source_id}:${d.external_id}`, d.source_version_id]));
    const gone = (await tx.find(EDITIONS, { tenant_id: tenantId, document })).filter((e) =>
      e.by === document ? !named.has(e.other) : e.versions[0] !== version.id,
    );
    if (gone.length) {
      await tx.delete(
        EDITIONS,
        gone.flatMap((e) => [EDITIONS.key(e), EDITIONS.key({ ...e, document: e.other, other: e.document })]),
      );
    }
    const rows = [...named].flatMap(([other, otherVersion]): Edition[] => [
      { tenant_id: tenantId, document, other, versions: [version.id, otherVersion], by: document },
      { tenant_id: tenantId, document: other, other: document, versions: [otherVersion, version.id], by: document },
    ]);
    if (rows.length) await tx.put(EDITIONS, rows);
  }

  /** Each new chunk's contextual header; a chunk the model leaves out has none. */
  async #headers(version: SourceVersion, drafts: readonly ChunkDraft[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const title = version.title ?? version.external_id;
    for (let i = 0; i < drafts.length; i += CONTEXTS_PER_CALL) {
      const batch = drafts.slice(i, i + CONTEXTS_PER_CALL);
      const input: ContextInput = {
        document: { title, ...(version.language && { language: version.language }) },
        chunks: batch.map((d, j) => ({
          ref: String(j + 1),
          heading_path: d.heading_path,
          text: d.text.slice(0, CONTEXT_CHARS),
        })),
      };
      const output = await complete<ContextOutput>(this.models, this.prompts, {
        task: CONTEXT_TASK,
        version: CONTEXT_PROMPT_VERSION,
        input,
        schema: CONTEXT_SCHEMA,
        sensitivity: version.sensitivity,
        tenantId: version.tenant_id,
        metadata: { source_version_id: version.id },
      });
      for (const h of output?.headers ?? []) {
        const d = batch[Number(h.ref) - 1];
        if (d && h.header.trim()) out.set(d.id, h.header.trim());
      }
    }
    return out;
  }

  async #embed(
    version: SourceVersion,
    chunks: readonly Chunk[],
  ): Promise<{ vectors: Record<string, number[]>; model: string } | undefined> {
    if (!chunks.length) return undefined;
    const vectors: Record<string, number[]> = {};
    let model = "";
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const result = await this.models.embed({
        texts: batch.map(searchText) as [string, ...string[]],
        input_type: "document",
        sensitivity: version.sensitivity,
        budget_key: `tenant:${version.tenant_id}/${COMPONENT}`,
        tenant_id: version.tenant_id,
      });
      model = result.model;
      batch.forEach((c, j) => {
        const v = result.vectors[j];
        if (v) vectors[c.id] = v;
      });
    }
    return { vectors, model };
  }

  async #serial<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#running.get(tenantId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(fn);
    this.#running.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(tenantId) === run) this.#running.delete(tenantId);
    }
  }
}
