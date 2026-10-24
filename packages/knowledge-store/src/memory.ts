/**
 * In-memory KnowledgeStore for component tests. Same rules and same results as Postgres; a
 * transaction works on a copy of the state and swaps it in on commit.
 */

import type {
  AclSnapshot,
  Chunk,
  Claim,
  ClaimDerivation,
  ClaimEvidence,
  ClaimQuery,
  DependencyEdge,
  EventEnvelope,
  EventPublisher,
  PageSnapshot,
  PageVersionInfo,
  SourceBlock,
  SourceVersion,
  Span,
  StoreTx,
} from "@inspiration/contracts";
import { BaseStore, type StoreOptions } from "./base.ts";
import { matches, QUERY_LIMIT } from "./query.ts";
import * as rules from "./rules.ts";

export interface Embedding {
  model: string;
  vector: number[];
}

const key = (...parts: string[]) => parts.join("\x1f");
const byKey = <V>(map: ReadonlyMap<string, V>) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const latest = (a: string, b: string) => Date.parse(a) - Date.parse(b);

class State {
  versions = new Map<string, SourceVersion>();
  /** By source version, in reading order. */
  blocks = new Map<string, readonly SourceBlock[]>();
  spans = new Map<string, Span>();
  chunks = new Map<string, Chunk>();
  embeddings = new Map<string, Embedding>();
  claims = new Map<string, Claim>();
  supersedeReasons = new Map<string, string>();
  /** By claim, span and role. */
  evidence = new Map<string, ClaimEvidence>();
  derivations = new Map<string, ClaimDerivation>();
  /** By artifact and input. */
  dependencies = new Map<string, DependencyEdge>();
  pages = new Map<string, ReadonlyMap<number, PageSnapshot>>();
  /** By source, external ID and ACL hash. */
  acls = new Map<string, AclSnapshot>();

  copy(): State {
    // Values are replaced, never mutated, so copying the containers is enough.
    const maps = Object.entries(this).map(([name, map]) => [name, new Map(map as Map<unknown, unknown>)]);
    return Object.assign(new State(), Object.fromEntries(maps));
  }
}

export class MemoryTx implements StoreTx {
  readonly events: EventEnvelope[] = [];
  readonly #store: MemoryStore;
  readonly #s: State;
  #open = true;

  constructor(store: MemoryStore, state: State) {
    this.#store = store;
    this.#s = state;
  }

  close(): void {
    this.#open = false;
  }

  /** The state this transaction writes, while it is open. */
  #state(): State {
    if (!this.#open) throw new Error("the transaction has ended");
    return this.#s;
  }

  async putSourceVersion(version: SourceVersion, spans: readonly Span[] = []): Promise<void> {
    const s = this.#state();
    rules.checkSourceVersion(version, spans);
    if (!s.versions.has(version.id)) s.versions.set(version.id, structuredClone(version));
    for (const sp of spans) if (!s.spans.has(sp.id)) s.spans.set(sp.id, structuredClone(sp));
  }

  async putBlocks(sourceVersionId: string, blocks: readonly SourceBlock[], spans: readonly Span[]): Promise<void> {
    const s = this.#state();
    const listed = blocks.flatMap((b) => b.span_ids).filter((id) => s.spans.has(id));
    rules.checkBlocks(s.versions.get(sourceVersionId), sourceVersionId, blocks, spans, new Set(listed));
    if (s.blocks.has(sourceVersionId)) return;
    for (const sp of spans) if (!s.spans.has(sp.id)) s.spans.set(sp.id, structuredClone(sp));
    s.blocks.set(sourceVersionId, structuredClone([...blocks].sort((a, b) => a.ordinal - b.ordinal)));
  }

  async putChunks(
    chunks: readonly Chunk[],
    embeddings?: Readonly<Record<string, readonly number[]>>,
    options: { model?: string } = {},
  ): Promise<void> {
    const s = this.#state();
    rules.checkChunks(chunks, new Set(s.versions.keys()), embeddings, options.model);
    for (const c of chunks) s.chunks.set(c.id, structuredClone(c));
    if (embeddings && options.model) this.#setEmbeddings(embeddings, options.model);
  }

  /** Upsert embeddings of stored chunks. */
  async putEmbeddings(items: Readonly<Record<string, readonly number[]>>, options: { model: string }): Promise<void> {
    const s = this.#state();
    rules.checkEmbeddings(items, options.model);
    const unknown = Object.keys(items).filter((id) => !s.chunks.has(id));
    if (unknown.length) throw new rules.IntegrityError(`embeddings for unknown chunks: ${unknown.sort().join(", ")}`);
    this.#setEmbeddings(items, options.model);
  }

  async removeEmbeddings(chunkIds: readonly string[]): Promise<void> {
    const s = this.#state();
    for (const id of chunkIds) s.embeddings.delete(id);
  }

  #setEmbeddings(items: Readonly<Record<string, readonly number[]>>, model: string): void {
    for (const [id, vector] of Object.entries(items)) this.#s.embeddings.set(id, { model, vector: [...vector] });
  }

  async removeChunks(chunkIds: readonly string[]): Promise<void> {
    const s = this.#state();
    for (const id of chunkIds) {
      s.chunks.delete(id);
      s.embeddings.delete(id);
    }
  }

  async upsertClaims(
    claims: readonly Claim[],
    evidence: readonly ClaimEvidence[],
    derivations: readonly ClaimDerivation[] = [],
  ): Promise<string[]> {
    const s = this.#state();
    const referenced = [
      ...claims.map((c) => c.id),
      ...evidence.map((e) => e.claim_id),
      ...derivations.flatMap((d) => [d.claim_id, ...d.from_claim_ids]),
    ];
    const existing = new Set(referenced.filter((id) => s.claims.has(id)));
    const supportedBefore = new Set(
      [...s.evidence.values()].filter((e) => e.role === "supports").map((e) => e.claim_id),
    );
    const alreadySupported = new Set(
      claims.filter((c) => s.derivations.has(c.id) || supportedBefore.has(c.id)).map((c) => c.id),
    );
    rules.checkClaims(claims, evidence, derivations, { existing, alreadySupported });
    for (const e of evidence) rules.checkEvidence(e, s.spans.get(e.span_id));
    for (const c of claims) s.claims.set(c.id, structuredClone(c));
    for (const d of derivations) s.derivations.set(d.claim_id, structuredClone(d));
    for (const e of evidence) s.evidence.set(key(e.claim_id, e.span_id, e.role), structuredClone(e));
    return claims.map((c) => c.id);
  }

  async supersede(claimId: string, by: string, reason: string): Promise<void> {
    const s = this.#state();
    const old = s.claims.get(claimId);
    rules.checkSupersede(old, s.claims.get(by), claimId, by);
    const now = this.#store.clock().toISOString();
    s.claims.set(claimId, { ...old, superseded_at: now, superseded_by: by, status: "superseded", updated_at: now });
    s.supersedeReasons.set(claimId, reason);
  }

  async recordDependencies(edges: readonly DependencyEdge[]): Promise<void> {
    const s = this.#state();
    const artifacts = new Set(edges.map((e) => e.artifact_id));
    for (const [k, e] of s.dependencies) if (artifacts.has(e.artifact_id)) s.dependencies.delete(k);
    for (const e of edges) s.dependencies.set(key(e.artifact_id, e.input_id), structuredClone(e));
  }

  async putPageSnapshot(snapshot: PageSnapshot): Promise<void> {
    const s = this.#state();
    const versions = s.pages.get(snapshot.page_id) ?? new Map<number, PageSnapshot>();
    rules.checkPageSnapshot(snapshot, versions.size ? Math.max(...versions.keys()) : undefined);
    s.pages.set(snapshot.page_id, new Map([...versions, [snapshot.version, structuredClone(snapshot)]]));
  }

  async putAclSnapshot(snapshot: AclSnapshot): Promise<void> {
    const s = this.#state();
    const k = key(snapshot.source_id, snapshot.external_id, snapshot.acl_hash);
    if (!s.acls.has(k)) s.acls.set(k, structuredClone(snapshot));
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    this.#state();
    this.events.push(...structuredClone(events));
  }
}

export interface MemoryStoreOptions extends StoreOptions {
  /** Receives the events of each committed transaction, after the commit. */
  publisher?: EventPublisher;
}

export class MemoryStore extends BaseStore {
  readonly publisher: EventPublisher | undefined;
  /** Events from committed transactions, in order. */
  readonly published: EventEnvelope[] = [];
  #state = new State();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions = {}) {
    super(options);
    this.publisher = options.publisher;
  }

  /** Transactions run one at a time, like serializable ones. */
  async transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const state = this.#state.copy();
      const tx = new MemoryTx(this, state);
      try {
        const result = await fn(tx);
        this.#state = state;
        this.published.push(...tx.events);
        return { result, events: tx.events };
      } finally {
        tx.close();
      }
    });
    this.#queue = run.catch(() => undefined);
    const { result, events } = await run;
    if (this.publisher && events.length) await this.publisher.publish(...events);
    return result;
  }

  // ---------------------------------------------------------- reads for the memory indexes

  /** The stored chunks, for the in-memory indexes. Do not modify them. */
  storedChunks(): IterableIterator<Chunk> {
    return this.#state.chunks.values();
  }

  /** The stored embeddings by chunk ID, for the in-memory indexes. Do not modify them. */
  storedEmbeddings(): ReadonlyMap<string, Embedding> {
    return this.#state.embeddings;
  }

  embeddingOf(chunkId: string): Embedding | undefined {
    const e = this.#state.embeddings.get(chunkId);
    return e && structuredClone(e);
  }

  // ---------------------------------------------------------- reads

  async getSourceVersion(versionId: string): Promise<SourceVersion | undefined> {
    return clone(this.#state.versions.get(versionId));
  }

  async latestSourceVersion(sourceId: string, externalId: string): Promise<SourceVersion | undefined> {
    const versions = [...this.#state.versions.values()].filter(
      (v) => v.source_id === sourceId && v.external_id === externalId,
    );
    versions.sort((a, b) => latest(b.fetched_at, a.fetched_at) || (a.id < b.id ? 1 : -1));
    return clone(versions[0]);
  }

  async getSpans(spanIds: readonly string[]): Promise<Span[]> {
    return pick(this.#state.spans, spanIds);
  }

  async spansOf(sourceVersionId: string): Promise<Span[]> {
    const blocks = this.#state.blocks.get(sourceVersionId);
    if (blocks)
      return pick(
        this.#state.spans,
        blocks.flatMap((b) => b.span_ids),
      );
    const spans = [...this.#state.spans.values()].filter((s) => s.source_version_id === sourceVersionId);
    return structuredClone(spans.sort((a, b) => a.ordinal - b.ordinal));
  }

  async blocksOf(sourceVersionId: string): Promise<SourceBlock[]> {
    return structuredClone([...(this.#state.blocks.get(sourceVersionId) ?? [])]);
  }

  async getChunks(chunkIds: readonly string[]): Promise<Chunk[]> {
    return pick(this.#state.chunks, chunkIds);
  }

  async chunksOf(sourceVersionId: string): Promise<Chunk[]> {
    const chunks = [...this.#state.chunks.values()].filter((c) => c.source_version_id === sourceVersionId);
    return structuredClone(chunks.sort((a, b) => a.ordinal - b.ordinal));
  }

  async getClaims(claimIds: readonly string[]): Promise<Claim[]> {
    return pick(this.#state.claims, claimIds);
  }

  async evidenceOf(claimIds: readonly string[]): Promise<ClaimEvidence[]> {
    const wanted = new Set(claimIds);
    return structuredClone(byKey(this.#state.evidence).flatMap(([, e]) => (wanted.has(e.claim_id) ? [e] : [])));
  }

  async claimsCiting(spanIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(spanIds);
    const ids = [...this.#state.evidence.values()].filter((e) => wanted.has(e.span_id)).map((e) => e.claim_id);
    return [...new Set(ids)].sort();
  }

  async asOf(query: ClaimQuery, options: { validAt?: Date; knownAt?: Date } = {}): Promise<Claim[]> {
    const asOf = { validAt: options.validAt, knownAt: options.knownAt ?? this.clock() };
    let withEvidenceIn: Set<string> | undefined;
    if (query.source_version_ids?.length) {
      const versions = new Set(query.source_version_ids);
      withEvidenceIn = new Set(
        [...this.#state.evidence.values()].filter((e) => versions.has(e.source_version_id)).map((e) => e.claim_id),
      );
    }
    const out = [...this.#state.claims.values()].filter(
      (c) => matches(c, query, asOf) && (!withEvidenceIn || withEvidenceIn.has(c.id)),
    );
    out.sort((a, b) => latest(a.recorded_at, b.recorded_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return structuredClone(out.slice(0, query.limit || QUERY_LIMIT));
  }

  async claimsInSlot(tenantId: string, slotKey: string): Promise<Claim[]> {
    const out = [...this.#state.claims.values()].filter((c) => c.tenant_id === tenantId && c.slot_key === slotKey);
    out.sort((a, b) => latest(a.recorded_at, b.recorded_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return structuredClone(out);
  }

  async dependents(artifactIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(artifactIds);
    const ids = [...this.#state.dependencies.values()].filter((e) => wanted.has(e.input_id)).map((e) => e.artifact_id);
    return [...new Set(ids)].sort();
  }

  async derivationsOf(claimIds: readonly string[]): Promise<ClaimDerivation[]> {
    return pick(this.#state.derivations, claimIds);
  }

  async inputsOf(artifactIds: readonly string[]): Promise<DependencyEdge[]> {
    const wanted = new Set(artifactIds);
    return structuredClone(byKey(this.#state.dependencies).flatMap(([, e]) => (wanted.has(e.artifact_id) ? [e] : [])));
  }

  async getPage(pageId: string, version?: number): Promise<PageSnapshot | undefined> {
    const versions = this.#state.pages.get(pageId);
    if (!versions?.size) return undefined;
    return clone(versions.get(version ?? Math.max(...versions.keys())));
  }

  async pageHistory(pageId: string): Promise<PageVersionInfo[]> {
    const versions = [...(this.#state.pages.get(pageId)?.values() ?? [])].sort((a, b) => a.version - b.version);
    return versions.map((p) => ({
      page_id: p.page_id,
      version: p.version,
      inputs_hash: p.spec.inputs_hash,
      cause: structuredClone(p.cause),
      ...(p.change_summary !== undefined && { change_summary: p.change_summary }),
      created_at: p.created_at,
    }));
  }

  async getAclSnapshot(sourceId: string, externalId: string, aclHash?: string): Promise<AclSnapshot | undefined> {
    if (aclHash !== undefined) return clone(this.#state.acls.get(key(sourceId, externalId, aclHash)));
    const found = [...this.#state.acls.values()].filter(
      (a) => a.source_id === sourceId && a.external_id === externalId,
    );
    found.sort((a, b) => latest(b.captured_at, a.captured_at) || (a.acl_hash < b.acl_hash ? 1 : -1));
    return clone(found[0]);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function pick<V>(map: ReadonlyMap<string, V>, ids: readonly string[]): V[] {
  return structuredClone(ids.flatMap((id) => map.get(id) ?? []));
}
