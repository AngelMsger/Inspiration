import { fileURLToPath } from "node:url";
import { aclTokens } from "@inspiration/access-control";
import {
  type AnswerNote,
  type AnswerQuery,
  type AuthZ,
  allows,
  type ChatMessage,
  type Chunk,
  type Citation,
  type Claim,
  type ClaimEvidence,
  type EventEnvelope,
  type EventHandler,
  type FreshnessInfo,
  type FreshnessState,
  GatewayException,
  type GroundedAnswer,
  type IndexFilter,
  type KeywordIndex,
  type KnowledgeStore,
  type ModelGateway,
  maxLabel,
  newId,
  type Principal,
  parseAs,
  payloadOf,
  type Retriever,
  rank,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SensitivityLabel,
  type SlotVerdict,
  type SlotVerdicts,
  type SourceVersion,
  type Span,
  type Staleness,
  type StalenessReader,
  slotOf,
  type VectorIndex,
  valueKeyOf,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { languageOf, logger } from "@inspiration/kernel";
import { searchText } from "@inspiration/knowledge-store";
import { estimateTokens, PromptRegistry } from "@inspiration/model-gateway";
import { type ChunkDraft, chunk } from "./chunks.ts";
import {
  ANSWER_PROMPT_VERSION,
  ANSWER_SCHEMA,
  ANSWER_TASK,
  type AnswerInput,
  type AnswerOutput,
  type AnswerSource,
  COMPONENT,
  CONTEXT_CHARS,
  CONTEXT_PROMPT_VERSION,
  CONTEXT_SCHEMA,
  CONTEXT_TASK,
  CONTEXTS_PER_CALL,
  type ContextInput,
  type ContextOutput,
} from "./protocol.ts";
import { fill, overlap, packFor, terms } from "./text.ts";

const log = logger(COMPONENT);
const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** Rows each index returns before fusion. */
export const POOL = 50;
/** Fused chunks whose statements and snippets the reranker sees. */
export const RERANK_POOL = 30;
/** Statements of those chunks the reranker sees, those sharing most of the query first. */
export const STATEMENT_POOL = 30;
/** Reciprocal rank fusion's constant. */
export const RRF_K = 60;
/** About how long a passage's snippet is. */
export const SNIPPET_TOKENS = 80;
/** Texts per embedding call. */
export const EMBED_BATCH = 64;
/** Passages an answer reads, and statements beside them. */
export const ANSWER_SOURCES = 8;
/** Below this confidence, a statement only one document states is thin evidence. */
export const THIN = 0.6;
/** An outdated value ranks as if it scored this share of its score. */
const OUTDATED_WEIGHT = 0.5;
/** The most a long-context baseline reads for one answer. */
export const LONG_CONTEXT_TOKENS = 150_000;
/** Statements that are no longer believed or never were. */
const CLOSED = new Set(["superseded", "retracted"]);
const SEVERITY: readonly FreshnessState[] = ["fresh", "aging", "stale", "at_risk"];

export type Baseline = "passages" | "long_context";

/** The documents a long-context baseline would read do not fit one context. */
export class ContextTooLong extends Error {
  override name = "ContextTooLong";
}

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

const key = (tenantId: string, id: string) => `${tenantId}|${id}`;

export const DOCUMENTS = defineTable<IndexedDocument>("retrieval.documents", {
  key: (d) => key(d.tenant_id, d.document),
  columns: { tenant_id: (d) => d.tenant_id },
});

export interface RetrievalOptions {
  store: KnowledgeStore;
  records: Records;
  models: ModelGateway;
  authz: AuthZ;
  vectors: VectorIndex;
  keywords: KeywordIndex;
  /** Where values stand with governance; without it no hit or answer is marked. */
  verdicts?: SlotVerdicts;
  /** How stale units are; without it every hit is fresh as of now. */
  staleness?: StalenessReader;
  /**
   * Answer the way a rival does, to measure the knowledge base against: "passages" is plain
   * retrieval over the same chunks, without statements or governance; "long_context" is a
   * model that reads every document the asker may read, for corpora that fit.
   */
  baseline?: Baseline;
  /** The most the long-context baseline reads for one answer; LONG_CONTEXT_TOKENS by default. */
  contextTokens?: number;
  prompts?: PromptRegistry;
  clock?: () => Date;
}

/** A chunk that passed the permission check, with its version and fused score. */
interface Found {
  chunk: Chunk;
  version: SourceVersion;
  fused: number;
  spans: Span[];
}

/** A statement found through the chunks that quote it. */
interface Statement {
  claim: Claim;
  base: number;
  citations: Citation[];
  title: string;
  version?: SourceVersion;
  verdict?: SlotVerdict;
}

interface Searched {
  hits: SearchHit[];
  statements: Map<string, Statement>;
  verdicts: Map<string, SlotVerdict>;
  filter: IndexFilter;
  filters?: SearchQuery["filters"];
  /** The sensitivity of every unit found. */
  labels: Map<string, SensitivityLabel>;
}

export class Retrieval implements Retriever {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly models: ModelGateway;
  readonly authz: AuthZ;
  readonly vectors: VectorIndex;
  readonly keywords: KeywordIndex;
  readonly verdicts: SlotVerdicts | undefined;
  readonly staleness: StalenessReader | undefined;
  readonly baseline: Baseline | undefined;
  readonly contextTokens: number;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly totals = { indexed: 0, chunks: 0, embedded: 0, searches: 0, answers: 0 };
  /** Index writes of one tenant run one at a time: they read and replace a document's record. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: RetrievalOptions) {
    this.store = options.store;
    this.records = options.records;
    this.models = options.models;
    this.authz = options.authz;
    this.vectors = options.vectors;
    this.keywords = options.keywords;
    this.verdicts = options.verdicts;
    this.staleness = options.staleness;
    this.baseline = options.baseline;
    this.contextTokens = options.contextTokens ?? LONG_CONTEXT_TOKENS;
    this.clock = options.clock ?? (() => new Date());
    if (options.prompts) this.prompts = options.prompts;
    else {
      this.prompts = new PromptRegistry();
      this.prompts.loadDir(PROMPTS_DIR);
    }
  }

  handlers(): Record<string, EventHandler> {
    return { "blocks.changed": this.onBlocksChanged, "acl.changed": this.onAclChanged };
  }

  readonly onBlocksChanged: EventHandler = async (event: EventEnvelope) => {
    await this.#serial(event.tenant_id, () => this.#index(event));
  };

  readonly onAclChanged: EventHandler = async (event: EventEnvelope) => {
    await this.#serial(event.tenant_id, () => this.#retoken(event));
  };

  /** The tenant's indexed documents. */
  async documents(tenantId: string): Promise<IndexedDocument[]> {
    return this.records.find(DOCUMENTS, { tenant_id: tenantId });
  }

  // ------------------------------------------------------------------ indexing

  async #index(event: EventEnvelope): Promise<void> {
    const change = payloadOf(event, "blocks.changed");
    const version = await this.store.getSourceVersion(change.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${change.source_version_id}`);
    const document = `${version.source_id}:${version.external_id}`;
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
      await this.records.transaction((tx) => tx.put(DOCUMENTS, [{ ...record, deleted: true }]));
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
    const tokens = await this.#tokensOf(version);
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
    await this.records.transaction((tx) => tx.put(DOCUMENTS, [{ ...record, chunk_ids: chunks.map((c) => c.id) }]));
    this.totals.indexed++;
    this.totals.chunks += chunks.length;
    this.totals.embedded += Object.keys(embedded?.vectors ?? {}).length;
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
      const output = await this.#complete<ContextOutput>({
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

  /** The tokens of the document's latest captured ACL; without one, only the tenant's services read it. */
  async #tokensOf(version: SourceVersion): Promise<string[]> {
    const snapshot = await this.store.getAclSnapshot(version.source_id, version.external_id);
    return snapshot ? aclTokens(snapshot, version.tenant_id) : [`system:${version.tenant_id}`];
  }

  async #retoken(event: EventEnvelope): Promise<void> {
    const changed = payloadOf(event, "acl.changed");
    const document = `${changed.source_id}:${changed.external_id}`;
    const state = await this.records.get(DOCUMENTS, key(event.tenant_id, document));
    // Not indexed yet: indexing reads the latest ACL itself.
    if (!state || state.deleted || !state.chunk_ids.length) return;
    // The latest snapshot, not the event's: a late event of an older ACL must not win.
    const snapshot = await this.store.getAclSnapshot(changed.source_id, changed.external_id);
    if (!snapshot) throw new RangeError(`no ACL snapshot for ${document}`);
    const tokens = aclTokens(snapshot, event.tenant_id);
    const chunks = await this.store.getChunks(state.chunk_ids);
    const changedChunks = chunks.filter((c) => JSON.stringify(c.acl_tokens ?? []) !== JSON.stringify(tokens));
    if (!changedChunks.length) return;
    await this.store.transaction((tx) => tx.putChunks(changedChunks.map((c) => ({ ...c, acl_tokens: tokens }))));
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

  // ------------------------------------------------------------------ search

  async search(q: SearchQuery, who: Principal): Promise<SearchResult> {
    const query = parseAs<SearchQuery>("SearchQuery", q);
    this.totals.searches++;
    const { hits } = await this.#search(query, who);
    let budget = query.token_budget ?? Number.POSITIVE_INFINITY;
    const kept: SearchHit[] = [];
    for (const h of hits) {
      if (h.token_estimate > budget && kept.length) break;
      kept.push(h);
      budget -= h.token_estimate;
    }
    return {
      query_id: newId("request"),
      hits: kept,
      token_estimate: kept.reduce((n, h) => n + h.token_estimate, 0),
    };
  }

  async #search(query: SearchQuery, who: Principal): Promise<Searched> {
    const topK = query.top_k ?? 10;
    const kinds = new Set(query.kinds?.length ? query.kinds : ["claim", "chunk"]);
    if (this.baseline) kinds.delete("claim");
    const filter = await this.#scope(who, query.space_ids);
    const empty: Searched = {
      hits: [],
      statements: new Map(),
      verdicts: new Map(),
      filter,
      labels: new Map(),
    };
    if (!filter.space_ids.length || (!kinds.has("claim") && !kinds.has("chunk"))) return empty;

    const fused = await this.#fused(query.text, who.tenant_id, filter);
    const found = await this.#readable(fused, who);
    if (!found.length) return empty;
    const words = terms(query.text);
    const statements = kinds.has("claim") ? await this.#statements(found, words, who, filter, query) : new Map();
    const verdicts = await this.#visibleVerdicts(
      who,
      await this.#verdictsOf(
        who.tenant_id,
        [...statements.values()].map((s) => s.claim),
      ),
      statements.values(),
    );
    for (const s of statements.values()) {
      const slot = slotOf(s.claim);
      if (slot) s.verdict = verdicts.get(slot);
    }

    // The reranker orders statements and passages together.
    const passages = kinds.has("chunk") ? found : [];
    const snippets = passages.map((f) => snippetOf(f, words));
    const listed = [...statements.values()];
    const texts = [...listed.map((s) => s.claim.statement), ...snippets.map((s) => s.text)];
    const sensitivity = maxLabel(
      "internal",
      ...listed.map((s) => s.claim.sensitivity),
      ...passages.map((f) => f.chunk.sensitivity),
    );
    const scores = texts.length ? await this.#rerank(query.text, texts, sensitivity, who.tenant_id) : [];
    const staleness = await this.#staleness(who.tenant_id, [
      ...listed.map((s) => s.claim.id),
      ...passages.map((f) => f.version.id),
    ]);
    const now = this.clock().toISOString();
    const freshness = (id: string): FreshnessInfo => freshnessOf(staleness.get(id), now);

    const hits: SearchHit[] = listed.map((s, i) =>
      statementHit(s, (scores[i] ?? 0) + s.base / 100, freshness(s.claim.id)),
    );
    passages.forEach((f, i) => {
      const snippet = snippets[i] as { text: string; spans: Span[] };
      hits.push(
        passageHit(f, snippet.spans, (scores[listed.length + i] ?? 0) + f.fused / 100, freshness(f.version.id)),
      );
    });
    hits.sort((a, b) => b.score - a.score || (a.unit_id < b.unit_id ? -1 : 1));
    const labels = new Map<string, SensitivityLabel>([
      ...listed.map((s): [string, SensitivityLabel] => [s.claim.id, s.claim.sensitivity]),
      ...passages.map((f): [string, SensitivityLabel] => [f.chunk.id, f.chunk.sensitivity]),
    ]);
    return {
      hits: hits.slice(0, topK),
      statements,
      verdicts,
      filter,
      ...(query.filters && { filters: query.filters }),
      labels,
    };
  }

  /** What the asker may read, within the spaces asked for when any are. */
  async #scope(who: Principal, spaceIds: readonly string[] | undefined): Promise<IndexFilter> {
    const filter = await this.authz.scopeFilter(who, "read");
    if (spaceIds?.length) {
      const asked = new Set(spaceIds);
      filter.space_ids = filter.space_ids.filter((s) => asked.has(s));
    }
    return filter;
  }

  /** Chunk IDs by reciprocal rank fusion of the vector and keyword indexes, best first. */
  async #fused(text: string, tenantId: string, filter: IndexFilter): Promise<[string, number][]> {
    const embedded = await this.models.embed({
      texts: [text],
      input_type: "query",
      // A question is the asker's own words, labelled as anything a member writes in the tenant.
      sensitivity: "internal",
      budget_key: `tenant:${tenantId}/${COMPONENT}`,
      tenant_id: tenantId,
    });
    const [vector, words] = await Promise.all([
      this.vectors.search(embedded.vectors[0] ?? [], POOL, filter),
      this.keywords.search(text, POOL, filter),
    ]);
    const fused = new Map<string, number>();
    for (const list of [vector, words]) {
      list.forEach((h, i) => {
        fused.set(h.chunk_id, (fused.get(h.chunk_id) ?? 0) + 1 / (RRF_K + (h.rank ?? i + 1)));
      });
    }
    return [...fused].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, RERANK_POOL);
  }

  /** The fused chunks of documents the asker may read now, the check the index filter cannot make. */
  async #readable(fused: readonly [string, number][], who: Principal): Promise<Found[]> {
    const chunks = await this.store.getChunks(fused.map(([id]) => id));
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const versions = await this.#versions(chunks.map((c) => c.source_version_id));
    const readable = await this.#readableDocuments(who, [...versions.values()]);
    const out: Found[] = [];
    for (const [id, score] of fused) {
      const c = byId.get(id);
      const v = c && versions.get(c.source_version_id);
      if (!c || !v || !readable.has(v.id)) continue;
      out.push({ chunk: c, version: v, fused: score * 100, spans: [] });
    }
    const spans = new Map((await this.store.getSpans(out.flatMap((f) => f.chunk.span_ids))).map((s) => [s.id, s]));
    for (const f of out) f.spans = f.chunk.span_ids.map((id) => spans.get(id)).filter((s) => s !== undefined);
    return out;
  }

  async #versions(ids: readonly string[]): Promise<Map<string, SourceVersion>> {
    const unique = [...new Set(ids)];
    const versions = await Promise.all(unique.map((id) => this.store.getSourceVersion(id)));
    return new Map(versions.filter((v) => v !== undefined).map((v) => [v.id, v]));
  }

  /** The IDs of the versions whose documents the asker may read. */
  async #readableDocuments(who: Principal, versions: readonly SourceVersion[]): Promise<Set<string>> {
    const decisions = await this.authz.checkMany(
      who,
      "read",
      versions.map((v) => ({ type: "document", id: `${v.source_id}:${v.external_id}` })),
    );
    return new Set(versions.filter((_, i) => decisions[i]?.allow).map((v) => v.id));
  }

  /**
   * The current statements the found passages quote, that the asker may read, with their
   * readable evidence as citations. Those sharing most of the query come first.
   */
  async #statements(
    found: readonly Found[],
    words: ReadonlySet<string>,
    who: Principal,
    filter: IndexFilter,
    query: SearchQuery,
  ): Promise<Map<string, Statement>> {
    const spanScore = new Map<string, number>();
    for (const f of found) for (const s of f.spans) spanScore.set(s.id, Math.max(spanScore.get(s.id) ?? 0, f.fused));
    const ids = await this.store.claimsCiting([...spanScore.keys()]);
    const claims = (await this.store.getClaims(ids)).filter(asked(filter, query.filters));
    const evidence = await this.store.evidenceOf(claims.map((c) => c.id));
    const supports = new Map<string, ClaimEvidence[]>();
    for (const e of evidence)
      if (e.role === "supports") supports.set(e.claim_id, [...(supports.get(e.claim_id) ?? []), e]);
    const ranked = claims
      .map((c) => {
        const base = Math.max(0, ...(supports.get(c.id) ?? []).map((e) => spanScore.get(e.span_id) ?? 0));
        return { c, base, near: overlap(words, c.statement) };
      })
      .filter((x) => x.base > 0)
      .sort((a, b) => b.near - a.near || b.base - a.base || (a.c.id < b.c.id ? -1 : 1))
      .slice(0, STATEMENT_POOL);
    const decisions = await this.authz.checkMany(
      who,
      "read",
      ranked.map((x) => ({ type: "claim", id: x.c.id })),
    );
    const allowed = ranked.filter((_, i) => decisions[i]?.allow);
    const cited = allowed.flatMap((x) => supports.get(x.c.id) ?? []);
    const versions = await this.#versions(cited.map((e) => e.source_version_id));
    const readable = await this.#readableDocuments(who, [...versions.values()]);
    const spans = new Map((await this.store.getSpans(cited.map((e) => e.span_id))).map((s) => [s.id, s]));
    const out = new Map<string, Statement>();
    for (const { c, base } of allowed) {
      // Hidden support is never cited or named.
      const own = (supports.get(c.id) ?? []).filter((e) => readable.has(e.source_version_id));
      const citations = own.flatMap((e) => {
        const span = spans.get(e.span_id);
        const v = versions.get(e.source_version_id);
        return span && v ? [citationOf(span, v, e.quote)] : [];
      });
      if (!citations.length) continue;
      const first = versions.get(own[0]?.source_version_id ?? "");
      out.set(c.id, {
        claim: c,
        base,
        citations,
        title: first ? titleOf(first) : c.statement,
        ...(first && { version: first }),
      });
    }
    return out;
  }

  async #verdictsOf(tenantId: string, claims: readonly Claim[]): Promise<Map<string, SlotVerdict>> {
    const slots = [...new Set(claims.map(slotOf).filter((s) => s !== undefined))];
    if (!this.verdicts || !slots.length) return new Map();
    return new Map((await this.verdicts.verdicts(tenantId, slots)).map((v) => [v.slot_key, v]));
  }

  /**
   * The verdicts as the asker may see them. A value keeps the statements of it the asker may
   * read, the representatives governance gave and those the search found; a value with none
   * is left out, and a contradiction stands only between values left. What a value the asker
   * cannot see does to the others is not theirs to know either: without the held value the
   * slot has no verdict for them, as if governance had none.
   */
  async #visibleVerdicts(
    who: Principal,
    verdicts: ReadonlyMap<string, SlotVerdict>,
    found: Iterable<Statement>,
  ): Promise<Map<string, SlotVerdict>> {
    const out = new Map<string, SlotVerdict>();
    if (!verdicts.size) return out;
    const own = new Map<string, string[]>();
    for (const s of found) {
      const slot = slotOf(s.claim);
      const value = valueKeyOf(s.claim);
      if (slot && value !== undefined)
        own.set(`${slot}|${value}`, [...(own.get(`${slot}|${value}`) ?? []), s.claim.id]);
    }
    const ids = [...new Set([...verdicts.values()].flatMap((v) => v.values.flatMap((x) => x.claim_ids)))];
    const decisions = await this.authz.checkMany(
      who,
      "read",
      ids.map((id) => ({ type: "claim", id })),
    );
    const readable = new Set(ids.filter((_, i) => decisions[i]?.allow));
    for (const [slot, verdict] of verdicts) {
      const values = verdict.values.flatMap((x) => {
        const mine = own.get(`${slot}|${x.value}`) ?? [];
        const claimIds = [...new Set([...x.claim_ids.filter((id) => readable.has(id)), ...mine])];
        return claimIds.length ? [{ ...x, claim_ids: claimIds as [string, ...string[]] }] : [];
      });
      const [held, ...rest] = values;
      if (!held || held.value !== verdict.values[0].value) continue;
      const contested = values.filter((x) => x.standing === "holds" || x.standing === "disputed").length > 1;
      out.set(slot, { ...verdict, values: [held, ...rest], disputed: verdict.disputed && contested });
    }
    return out;
  }

  /**
   * Scores for the texts, labelled as the most sensitive of them: that the asker may read a
   * text does not clear a provider to see it. With no reranker cleared for the label the
   * fused order stands.
   */
  async #rerank(
    query: string,
    texts: readonly string[],
    sensitivity: SensitivityLabel,
    tenantId: string,
  ): Promise<number[]> {
    try {
      const result = await this.models.rerank({
        query,
        documents: [...texts] as [string, ...string[]],
        sensitivity,
        budget_key: `tenant:${tenantId}/${COMPONENT}`,
        tenant_id: tenantId,
      });
      return result.scores;
    } catch (e) {
      if (!(e instanceof GatewayException && e.code === "no_route")) throw e;
      log.warn("no reranker for the label; keeping the fused order", { sensitivity });
      return [];
    }
  }

  async #staleness(tenantId: string, unitIds: readonly string[]): Promise<Map<string, Staleness>> {
    if (!this.staleness || !unitIds.length) return new Map();
    return new Map((await this.staleness.staleness(tenantId, [...new Set(unitIds)])).map((s) => [s.unit_id, s]));
  }

  // ------------------------------------------------------------------ answers

  /** The hits an answer to the question reads, in the order the model is given them. */
  async sources(q: AnswerQuery, who: Principal): Promise<SearchHit[]> {
    return (await this.#sources(parseAs<AnswerQuery>("AnswerQuery", q), who)).hits;
  }

  /**
   * The best passages and, beside them, the best statements, ANSWER_SOURCES of each, so a
   * statement never takes the place of a passage; then the values that hold instead of the
   * ones found that do not.
   */
  async #sources(query: AnswerQuery, who: Principal): Promise<{ hits: SearchHit[]; searched: Searched }> {
    if (this.baseline === "long_context") return this.#everything(query, who);
    const found = await this.#search(
      {
        text: query.question,
        top_k: RERANK_POOL + STATEMENT_POOL,
        kinds: ["claim", "chunk"],
        ...(query.space_ids && { space_ids: query.space_ids }),
        ...(query.filters && { filters: query.filters }),
      },
      who,
    );
    const taken = new Map<string, number>();
    const best = found.hits.filter((h) => {
      const n = taken.get(h.kind) ?? 0;
      taken.set(h.kind, n + 1);
      return n < ANSWER_SOURCES;
    });
    const searched = { ...found, hits: best };
    const hits = passagesWithoutReplaced(searched);
    await this.#addHeld(hits, searched, who);
    return { hits, searched };
  }

  /**
   * Every passage the asker may read in the spaces asked for, document by document in
   * reading order. The query's filters are on statements, which a passage is not, as for the
   * passages baseline.
   */
  async #everything(query: AnswerQuery, who: Principal): Promise<{ hits: SearchHit[]; searched: Searched }> {
    const filter = await this.#scope(who, query.space_ids);
    const spaces = new Set(filter.space_ids);
    const ids = spaces.size ? (await this.documents(who.tenant_id)).flatMap((d) => d.chunk_ids) : [];
    const found = (
      await this.#readable(
        ids.map((id): [string, number] => [id, 0]),
        who,
      )
    ).filter((f) => spaces.has(f.chunk.space_id) && allows(filter.max_sensitivity, f.chunk.sensitivity));
    const tokens = found.reduce((n, f) => n + f.chunk.token_count, 0);
    if (tokens > this.contextTokens) {
      throw new ContextTooLong(`${tokens} tokens in ${found.length} passages, more than ${this.contextTokens}`);
    }
    const now = this.clock().toISOString();
    const hits = found.map((f) => passageHit(f, f.spans, 0, { state: "fresh", as_of: now }));
    const labels = new Map(found.map((f): [string, SensitivityLabel] => [f.chunk.id, f.chunk.sensitivity]));
    return { hits, searched: { hits, statements: new Map(), verdicts: new Map(), filter, labels } };
  }

  async answer(q: AnswerQuery, who: Principal): Promise<GroundedAnswer> {
    const query = parseAs<AnswerQuery>("AnswerQuery", q);
    this.totals.answers++;
    const language = languageOf(query.question);
    const pack = packFor(language);
    const { hits, searched } = await this.#sources(query, who);
    const refOf = new Map(hits.map((h, i) => [h.unit_id, String(i + 1)]));
    const sources: AnswerSource[] = hits.map((h, i) => {
      const held = h.held_unit_id && refOf.get(h.held_unit_id);
      return {
        ref: String(i + 1),
        kind: h.kind === "claim" ? "statement" : "passage",
        title: h.title,
        text: h.kind === "claim" ? h.snippet : h.citations.map((c) => c.quote).join("\n"),
        ...(h.standing && { standing: h.standing }),
        ...(held && { held_ref: held }),
      };
    });
    const now = this.clock().toISOString();
    if (!sources.length) {
      return {
        answer_id: newId("request"),
        answer: pack.text("nothing"),
        citations: [],
        confidence: 0,
        gaps: [query.question],
        freshness: { state: "fresh", as_of: now },
        token_estimate: estimateTokens(pack.text("nothing")),
      };
    }
    // The question is labelled internal, as anything a member writes; the sources as they are.
    const sensitivity = maxLabel("internal", ...hits.map((h) => searched.labels.get(h.unit_id) ?? "internal"));
    const input: AnswerInput = {
      question: query.question,
      language,
      ...(query.context && { context: query.context }),
      sources,
    };
    const output = await this.#complete<AnswerOutput>({
      task: ANSWER_TASK,
      version: ANSWER_PROMPT_VERSION,
      input,
      schema: ANSWER_SCHEMA,
      sensitivity,
      tenantId: who.tenant_id,
      ...(query.max_answer_tokens && { maxOutputTokens: query.max_answer_tokens }),
    });

    // Every sentence cites what it rests on; one that cites nothing given is dropped.
    const citations: Citation[] = [];
    const numberOf = new Map<string, number>();
    const used: string[] = [];
    const sentences: string[] = [];
    for (const s of output?.sentences ?? []) {
      const refs = s.sources.map((r) => hits[Number(r) - 1]).filter((h): h is SearchHit => h !== undefined);
      if (!refs.length) continue;
      const marks: number[] = [];
      for (const h of refs) {
        if (!used.includes(h.unit_id)) used.push(h.unit_id);
        // A sentence that quotes some of a passage's sentences cites those, else all of them.
        const quoted = h.citations.filter((c) => c.quote.trim() && s.text.includes(c.quote.trim()));
        for (const c of quoted.length ? quoted : h.citations) {
          const id = `${c.span_id}|${c.quote}`;
          if (!numberOf.has(id)) numberOf.set(id, citations.push(c));
          marks.push(numberOf.get(id) as number);
        }
      }
      sentences.push(`${s.text.trim()} ${[...new Set(marks)].map((n) => `[${n}]`).join("")}`);
    }
    const answer = sentences.length ? sentences.join(pack.text("sentence_join") || " ") : pack.text("nothing");
    const cited = hits.filter((h) => used.includes(h.unit_id));
    // Notes on the values the answer gives: the slots of the statements found that quote what
    // it cites and state a value, whether the answer cites the statement or its passage.
    const quoted = new Set(citations.map((c) => c.span_id));
    const slots = new Set(
      [...searched.statements.values()].flatMap((s) => {
        const slot = slotOf(s.claim);
        const states = slot && standingOf(s.claim, s.verdict) && s.citations.some((c) => quoted.has(c.span_id));
        return states ? [slot] : [];
      }),
    );
    const notes = notesOf(slots, hits, searched, pack);
    const thin = cited.filter((h) => {
      const s = searched.statements.get(h.unit_id);
      return s && s.claim.confidence < THIN && new Set(s.citations.map((c) => c.source_version_id)).size === 1;
    });
    for (const h of thin) {
      notes.push({
        kind: "thin_evidence",
        text: fill(pack.text("thin_evidence"), { document: h.title }),
        unit_ids: [h.unit_id],
      });
    }
    const worst = cited.reduce<FreshnessInfo | undefined>(
      (w, h) => (!w || SEVERITY.indexOf(h.freshness.state) > SEVERITY.indexOf(w.state) ? h.freshness : w),
      undefined,
    );
    return {
      answer_id: newId("request"),
      answer,
      citations,
      used_unit_ids: used,
      confidence: sentences.length ? Math.max(0, Math.min(1, output?.confidence ?? 0)) : 0,
      gaps: sentences.length ? (output?.gaps ?? []) : [query.question],
      freshness: worst ?? { state: "fresh", as_of: now },
      token_estimate: estimateTokens(answer) + citations.reduce((n, c) => n + estimateTokens(c.quote), 0),
      ...(notes.length && { notes }),
    };
  }

  /**
   * The value that holds takes the place of an outdated or disputed one the question found:
   * its statement joins the sources when the asker may read it and it passes the search's
   * filters, as the hit of a search, with its freshness.
   */
  async #addHeld(hits: SearchHit[], searched: Searched, who: Principal): Promise<void> {
    const have = new Set(hits.map((h) => h.unit_id));
    const wanted = [
      ...new Set(hits.flatMap((h) => (h.held_unit_id && !have.has(h.held_unit_id) ? [h.held_unit_id] : []))),
    ];
    if (!wanted.length) return;
    const decisions = await this.authz.checkMany(
      who,
      "read",
      wanted.map((id) => ({ type: "claim", id })),
    );
    const claims = (await this.store.getClaims(wanted.filter((_, i) => decisions[i]?.allow))).filter(
      asked(searched.filter, searched.filters),
    );
    if (!claims.length) return;
    const evidence = (await this.store.evidenceOf(claims.map((c) => c.id))).filter((e) => e.role === "supports");
    const versions = await this.#versions(evidence.map((e) => e.source_version_id));
    const readable = await this.#readableDocuments(who, [...versions.values()]);
    const spans = new Map((await this.store.getSpans(evidence.map((e) => e.span_id))).map((s) => [s.id, s]));
    const staleness = await this.#staleness(
      who.tenant_id,
      claims.map((c) => c.id),
    );
    const now = this.clock().toISOString();
    for (const c of claims) {
      const own = evidence.filter((e) => e.claim_id === c.id && readable.has(e.source_version_id));
      const citations = own.flatMap((e) => {
        const span = spans.get(e.span_id);
        const v = versions.get(e.source_version_id);
        return span && v ? [citationOf(span, v, e.quote)] : [];
      });
      const first = versions.get(own[0]?.source_version_id ?? "");
      if (!citations.length || !first) continue;
      const slot = slotOf(c);
      const verdict = slot ? searched.verdicts.get(slot) : undefined;
      const statement: Statement = {
        claim: c,
        base: 0,
        citations,
        title: titleOf(first),
        version: first,
        ...(verdict && { verdict }),
      };
      searched.statements.set(c.id, statement);
      searched.labels.set(c.id, c.sensitivity);
      hits.push(statementHit(statement, 0, freshnessOf(staleness.get(c.id), now)));
    }
  }

  async #complete<T>(call: {
    task: string;
    version: string;
    input: unknown;
    schema: Record<string, unknown>;
    sensitivity: SensitivityLabel;
    tenantId: string;
    maxOutputTokens?: number;
    metadata?: Record<string, string>;
  }): Promise<T | undefined> {
    try {
      const completion = await this.models.complete({
        task: call.task,
        prompt_version: call.version,
        messages: this.prompts.render(call.task, call.version, { input: JSON.stringify(call.input) }) as [
          ChatMessage,
          ...ChatMessage[],
        ],
        response_schema: call.schema,
        tier: "flash",
        sensitivity: call.sensitivity,
        budget_key: `tenant:${call.tenantId}/${COMPONENT}`,
        tenant_id: call.tenantId,
        temperature: 0,
        ...(call.maxOutputTokens && { max_output_tokens: call.maxOutputTokens }),
        ...(call.metadata && { metadata: call.metadata }),
      });
      return completion.json as T;
    } catch (e) {
      // An answer the model cannot give validly is no answer; budgets and outages are raised.
      if (e instanceof GatewayException && e.code === "invalid_output") {
        log.warn("no valid output", { task: call.task, error: e.message });
        return undefined;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- helpers

function titleOf(version: SourceVersion, path?: readonly string[]): string {
  const title = version.title ?? version.external_id;
  const last = path?.at(-1);
  return last && last !== title ? `${title} › ${last}` : title;
}

function citationOf(span: Span, version: SourceVersion, quote: string): Citation {
  return {
    span_id: span.id,
    source_version_id: version.id,
    source_title: version.title ?? version.external_id,
    ...(version.uri && { uri: version.uri }),
    quote,
    locator: span.locator,
    fetched_at: version.fetched_at,
  };
}

/**
 * The spans of a found chunk that share most of the query, in reading order, up to about
 * SNIPPET_TOKENS; the first span when none shares a word.
 */
function snippetOf(f: Found, words: ReadonlySet<string>): { text: string; spans: Span[] } {
  const ranked = f.spans
    .map((s, i) => ({ s, i, near: overlap(words, s.text) }))
    .sort((a, b) => b.near - a.near || a.i - b.i);
  const picked: typeof ranked = [];
  let size = 0;
  for (const r of ranked) {
    if (picked.length && (r.near === 0 || size + estimateTokens(r.s.text) > SNIPPET_TOKENS)) break;
    picked.push(r);
    size += estimateTokens(r.s.text);
  }
  const spans = picked.sort((a, b) => a.i - b.i).map((r) => r.s);
  return { text: spans.map((s) => s.text).join(" "), spans };
}

/** A passage as a hit, quoting the spans given. */
function passageHit(f: Found, spans: readonly Span[], score: number, freshness: FreshnessInfo): SearchHit {
  return {
    unit_id: f.chunk.id,
    kind: "chunk",
    title: titleOf(f.version, f.chunk.heading_path),
    snippet: spans.map((s) => s.text).join(" "),
    score,
    citations: spans.map((span) => citationOf(span, f.version, span.text)),
    freshness,
    review_status: "unreviewed",
    token_estimate: f.chunk.token_count + estimateTokens(f.chunk.contextual_header ?? ""),
    space_id: f.chunk.space_id,
    ...(f.version.language && { language: f.version.language }),
  };
}

/** Whether a claim is current and within what the search asked for and the asker's scope. */
function asked(filter: IndexFilter, f: SearchQuery["filters"]): (c: Claim) => boolean {
  const spaces = new Set(filter.space_ids);
  return (c) =>
    !c.superseded_at &&
    !CLOSED.has(c.status) &&
    spaces.has(c.space_id) &&
    rank(c.sensitivity) <= rank(filter.max_sensitivity) &&
    (!f?.knowledge_classes?.length || f.knowledge_classes.includes(c.knowledge_class)) &&
    (!f?.statuses?.length || f.statuses.includes(c.status)) &&
    (f?.min_confidence === undefined || c.confidence >= f.min_confidence);
}

/** A statement as a hit, marked with where its value stands and which value holds instead. */
function statementHit(s: Statement, score: number, freshness: FreshnessInfo): SearchHit {
  const standing = standingOf(s.claim, s.verdict);
  const held = s.verdict && standing !== "holds" ? s.verdict.values[0]?.claim_ids[0] : undefined;
  const slot = slotOf(s.claim);
  // Both sides of an open contradiction are in dispute, the one that holds for now too.
  const disputed = s.verdict?.disputed && (standing === "holds" || standing === "disputed");
  return {
    unit_id: s.claim.id,
    kind: "claim",
    title: s.title,
    snippet: s.claim.statement,
    score: score * (standing === "outdated" ? OUTDATED_WEIGHT : 1),
    citations: s.citations,
    freshness,
    confidence: s.claim.confidence,
    review_status: disputed ? "disputed" : s.claim.status === "verified" ? "verified" : "unreviewed",
    ...(s.claim.owner_id && { owner_id: s.claim.owner_id }),
    token_estimate:
      estimateTokens(s.claim.statement) +
      s.citations.reduce((n: number, c: Citation) => n + estimateTokens(c.quote), 0),
    space_id: s.claim.space_id,
    ...(s.claim.language && { language: s.claim.language }),
    ...(slot && { slot_key: slot }),
    ...(standing && { standing }),
    ...(held && held !== s.claim.id && { held_unit_id: held }),
  };
}

/**
 * The hits an answer reads. A passage's sentence that states a value of a fact slot other
 * than the one that holds brings its statement along, marked, so the value that holds joins
 * too; a sentence that only states replaced values is left out of the passage, and a
 * passage with nothing left is left out.
 */
function passagesWithoutReplaced(searched: Searched): SearchHit[] {
  const quoting = new Map<string, Statement[]>();
  for (const s of searched.statements.values()) {
    if (!standingOf(s.claim, s.verdict)) continue;
    for (const c of s.citations) quoting.set(c.span_id, [...(quoting.get(c.span_id) ?? []), s]);
  }
  const have = new Set(searched.hits.map((h) => h.unit_id));
  const hits: SearchHit[] = [];
  const brought: SearchHit[] = [];
  for (const h of searched.hits) {
    if (h.kind !== "chunk") {
      hits.push(h);
      continue;
    }
    const kept = h.citations.filter((c) => {
      const by = quoting.get(c.span_id) ?? [];
      for (const s of by) {
        if (have.has(s.claim.id) || standingOf(s.claim, s.verdict) === "holds") continue;
        have.add(s.claim.id);
        brought.push(statementHit(s, 0, h.freshness));
      }
      return !by.length || by.some((s) => standingOf(s.claim, s.verdict) !== "outdated");
    });
    if (kept.length === h.citations.length) hits.push(h);
    else if (kept.length) hits.push({ ...h, citations: kept, snippet: kept.map((c) => c.quote).join(" ") });
  }
  return [...hits, ...brought];
}

function standingOf(claim: Claim, verdict: SlotVerdict | undefined): SearchHit["standing"] {
  if (!verdict) return undefined;
  const value = valueKeyOf(claim);
  return verdict.values.find((v) => v.value === value)?.standing;
}

function freshnessOf(s: Staleness | undefined, now: string): FreshnessInfo {
  if (!s) return { state: "fresh", as_of: now };
  return {
    state: s.state,
    as_of: s.computed_at,
    staleness: s.score,
    ...(s.review_due && { review_due: s.review_due }),
  };
}

/** Notes on the slots an answer gives a value of: disputed slots, and outdated values found. */
function notesOf(
  slots: ReadonlySet<string>,
  hits: readonly SearchHit[],
  searched: Searched,
  pack: ReturnType<typeof packFor>,
): AnswerNote[] {
  const notes: AnswerNote[] = [];
  const mark = pack.text("list_mark");
  for (const slot of [...slots].sort()) {
    const verdict = searched.verdicts.get(slot);
    if (!verdict) continue;
    const mine = hits.filter((h) => h.slot_key === slot);
    if (verdict.disputed) {
      const disputed = verdict.values.filter((v) => v.standing === "holds" || v.standing === "disputed");
      notes.push({
        kind: "conflict",
        text: fill(pack.text("conflict"), {
          values: disputed.map((v) => v.value).join(mark),
          held: verdict.held_value,
        }),
        unit_ids: [...new Set(disputed.flatMap((v) => v.claim_ids))],
      });
    }
    const outdated = mine.filter((h) => h.standing === "outdated");
    if (outdated.length) {
      const old = [...new Set(outdated.map((h) => valueKeyOf(searched.statements.get(h.unit_id)?.claim ?? {}) ?? ""))];
      notes.push({
        kind: "outdated",
        text: fill(pack.text("outdated"), {
          documents: [...new Set(outdated.map((h) => h.title))].join(mark),
          old: old.join(mark),
          held: verdict.held_value,
        }),
        unit_ids: [...outdated.map((h) => h.unit_id), ...(verdict.values[0]?.claim_ids ?? [])],
      });
    }
  }
  return notes;
}
