import {
  type AuthZ,
  type Claim,
  type ClaimEvidence,
  type FreshnessInfo,
  GatewayException,
  type IndexFilter,
  type KeywordIndex,
  type KnowledgeStore,
  type ModelGateway,
  maxLabel,
  type Principal,
  rank,
  type SearchHit,
  type SearchQuery,
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
import { languageOf, logger } from "@inspiration/kernel";
import type { PromptRegistry } from "@inspiration/model-gateway";
import {
  citationOf,
  type Found,
  freshnessOf,
  passageHit,
  type Searched,
  type Statement,
  snippetOf,
  spanScores,
  statementHit,
  titleOf,
} from "./hits.ts";
import {
  COMPONENT,
  complete,
  TRANSLATE_PROMPT_VERSION,
  TRANSLATE_SCHEMA,
  TRANSLATE_TASK,
  type TranslateInput,
  type TranslateOutput,
} from "./protocol.ts";
import { overlap, PACKS, terms } from "./text.ts";

// Search: what the asker may read that the question finds, through the vector and keyword
// indexes, fused and reranked, each hit checked against the document's permission and marked
// with where its value stands. Retrieval's doc comment (index.ts) describes the behaviour;
// answers.ts answers from what this finds.

const log = logger(COMPONENT);

/** Rows each index returns before fusion. */
export const POOL = 50;
/** Fused chunks whose statements and snippets the reranker sees. */
export const RERANK_POOL = 15;
/**
 * Fused chunks the mature baseline reranks: more than the MATURE_SOURCES it reads, as a
 * carefully built RAG reranks, and as many as in every run it was measured in.
 */
export const MATURE_POOL = 30;
/** Statements of those chunks the reranker sees, those sharing most of the query first. */
export const STATEMENT_POOL = 15;
/** Reciprocal rank fusion's constant. */
export const RRF_K = 60;
/** Statements that are no longer believed or never were. */
const CLOSED = new Set(["superseded", "retracted"]);

export type Baseline = "mature" | "long_context";

/** What search counts, in Retrieval.totals. */
export interface SearchTotals {
  searches: number;
  untranslated: number;
}

export class Search {
  readonly store: KnowledgeStore;
  readonly models: ModelGateway;
  readonly authz: AuthZ;
  readonly vectors: VectorIndex;
  readonly keywords: KeywordIndex;
  readonly verdicts: SlotVerdicts | undefined;
  readonly staleness: StalenessReader | undefined;
  readonly baseline: Baseline | undefined;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly totals: SearchTotals;

  constructor(options: {
    store: KnowledgeStore;
    models: ModelGateway;
    authz: AuthZ;
    vectors: VectorIndex;
    keywords: KeywordIndex;
    verdicts: SlotVerdicts | undefined;
    staleness: StalenessReader | undefined;
    baseline: Baseline | undefined;
    prompts: PromptRegistry;
    clock: () => Date;
    totals: SearchTotals;
  }) {
    this.store = options.store;
    this.models = options.models;
    this.authz = options.authz;
    this.vectors = options.vectors;
    this.keywords = options.keywords;
    this.verdicts = options.verdicts;
    this.staleness = options.staleness;
    this.baseline = options.baseline;
    this.prompts = options.prompts;
    this.clock = options.clock;
    this.totals = options.totals;
  }

  /** With whole, a passage hit quotes all its spans, as an answer reads it; else a snippet of them. */
  async find(query: SearchQuery, who: Principal, whole = false): Promise<Searched> {
    const topK = query.top_k ?? 10;
    const kinds = new Set(query.kinds?.length ? query.kinds : ["claim", "chunk"]);
    if (this.baseline) kinds.delete("claim");
    const filter = await this.scope(who, query.space_ids);
    const empty: Searched = {
      hits: [],
      statements: new Map(),
      verdicts: new Map(),
      filter,
      labels: new Map(),
    };
    if (!filter.space_ids.length || (!kinds.has("claim") && !kinds.has("chunk"))) return empty;

    const fused = await this.#fused(query.text, who.tenant_id, filter);
    const found = await this.readable(fused, who);
    if (!found.length) return empty;
    const words = terms(query.text);
    const statements = kinds.has("claim")
      ? await this.statements(spanScores(found), words, who, filter, query)
      : new Map();
    const verdicts = await this.visibleVerdicts(
      who,
      await this.verdictsOf(
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
    const snippets = passages.map((f) =>
      whole ? { text: f.spans.map((s) => s.text).join(" "), spans: f.spans } : snippetOf(f, words),
    );
    const listed = [...statements.values()];
    const texts = [...listed.map((s) => s.claim.statement), ...snippets.map((s) => s.text)];
    const sensitivity = maxLabel(
      "internal",
      ...listed.map((s) => s.claim.sensitivity),
      ...passages.map((f) => f.chunk.sensitivity),
    );
    const scores = texts.length ? await this.#rerank(query.text, texts, sensitivity, who.tenant_id) : [];
    const staleness = await this.stalenessOf(who.tenant_id, [
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

  /**
   * The readable current statements resting on these spans (those `keep` keeps), marked with
   * their verdicts and freshness and sorted, and the statements that hold in place of the
   * outdated and disputed ones.
   */
  async marked(
    who: Principal,
    spanScore: ReadonlyMap<string, number>,
    order: (a: SearchHit, b: SearchHit) => number,
    keep: (claimId: string) => boolean = () => true,
  ): Promise<{ hits: SearchHit[]; held: SearchHit[] }> {
    const filter = await this.scope(who, undefined);
    const found = await this.statements(spanScore, new Set(), who, filter, {}, { limit: Number.POSITIVE_INFINITY });
    const statements = new Map([...found].filter(([id]) => keep(id)));
    const verdicts = await this.visibleVerdicts(
      who,
      await this.verdictsOf(
        who.tenant_id,
        [...statements.values()].map((s) => s.claim),
      ),
      statements.values(),
    );
    for (const s of statements.values()) {
      const slot = slotOf(s.claim);
      if (slot) s.verdict = verdicts.get(slot);
    }
    const listed = [...statements.values()];
    const staleness = await this.stalenessOf(
      who.tenant_id,
      listed.map((s) => s.claim.id),
    );
    const now = this.clock().toISOString();
    const hits = listed.map((s) => statementHit(s, 0, freshnessOf(staleness.get(s.claim.id), now))).sort(order);
    const searched: Searched = { hits, statements, verdicts, filter, labels: new Map() };
    const all = [...hits];
    await this.addHeld(all, searched, who);
    return { hits, held: all.slice(hits.length) };
  }

  /** What the asker may read, within the spaces asked for when any are. */
  async scope(who: Principal, spaceIds: readonly string[] | undefined): Promise<IndexFilter> {
    const filter = await this.authz.scopeFilter(who, "read");
    if (spaceIds?.length) {
      const asked = new Set(spaceIds);
      filter.space_ids = filter.space_ids.filter((s) => asked.has(s));
    }
    return filter;
  }

  /**
   * Chunk IDs by reciprocal rank fusion of the vector and keyword indexes, searched with the
   * text and with its translations, best first. The text is searched while it is translated.
   */
  async #fused(text: string, tenantId: string, filter: IndexFilter): Promise<[string, number][]> {
    const [own, translated] = await Promise.all([
      this.#ranked([text], tenantId, filter),
      this.#translations(text, tenantId).then((texts) => this.#ranked(texts, tenantId, filter)),
    ]);
    const fused = new Map<string, number>();
    for (const list of [...own, ...translated]) {
      list.forEach((h, i) => {
        fused.set(h.chunk_id, (fused.get(h.chunk_id) ?? 0) + 1 / (RRF_K + (h.rank ?? i + 1)));
      });
    }
    const pool = this.baseline === "mature" ? MATURE_POOL : RERANK_POOL;
    return [...fused].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, pool);
  }

  /** The vector and keyword indexes' rows for each text. */
  async #ranked(texts: readonly string[], tenantId: string, filter: IndexFilter) {
    if (!texts.length) return [];
    const embedded = await this.models.embed({
      texts: [...texts] as [string, ...string[]],
      input_type: "query",
      // A question is the asker's own words, labelled as anything a member writes in the tenant.
      sensitivity: "internal",
      budget_key: `tenant:${tenantId}/${COMPONENT}`,
      tenant_id: tenantId,
    });
    return Promise.all(
      texts.flatMap((t, i) => [
        this.vectors.search(embedded.vectors[i] ?? [], POOL, filter),
        this.keywords.search(t, POOL, filter),
      ]),
    );
  }

  /**
   * The question in the other languages retrieval has packs for, so it finds documents
   * written in them by their words too. Without a model to translate it, none: the question
   * alone still searches.
   */
  async #translations(question: string, tenantId: string): Promise<string[]> {
    const own = languageOf(question);
    const languages = PACKS.map((p) => p.tag).filter((t) => t !== own);
    if (!languages.length) return [];
    let output: TranslateOutput | undefined;
    try {
      output = await complete<TranslateOutput>(this.models, this.prompts, {
        task: TRANSLATE_TASK,
        version: TRANSLATE_PROMPT_VERSION,
        input: { question, languages } satisfies TranslateInput,
        schema: TRANSLATE_SCHEMA,
        sensitivity: "internal",
        tenantId,
      });
    } catch (e) {
      if (!(e instanceof GatewayException)) throw e;
      log.warn("question not translated; searching with it alone", { code: e.code, error: e.message });
    }
    // No valid reply (complete logs it) is no translation either.
    if (!output) {
      this.totals.untranslated++;
      return [];
    }
    const asked = new Set(languages);
    const texts = output.translations
      .filter((t) => asked.has(t.language))
      .map((t) => t.text.trim())
      .filter((t) => t && t !== question);
    return [...new Set(texts)];
  }

  /** The fused chunks of documents the asker may read now, the check the index filter cannot make. */
  async readable(fused: readonly [string, number][], who: Principal): Promise<Found[]> {
    const chunks = await this.store.getChunks(fused.map(([id]) => id));
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const versions = await this.versions(chunks.map((c) => c.source_version_id));
    const readable = await this.readableDocuments(who, [...versions.values()]);
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

  async versions(ids: readonly string[]): Promise<Map<string, SourceVersion>> {
    const unique = [...new Set(ids)];
    const versions = await Promise.all(unique.map((id) => this.store.getSourceVersion(id)));
    return new Map(versions.filter((v) => v !== undefined).map((v) => [v.id, v]));
  }

  /** The IDs of the versions whose documents the asker may read. */
  async readableDocuments(who: Principal, versions: readonly SourceVersion[]): Promise<Set<string>> {
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
  async statements(
    spanScore: ReadonlyMap<string, number>,
    words: ReadonlySet<string>,
    who: Principal,
    filter: IndexFilter,
    query: Pick<SearchQuery, "filters">,
    options: { limit?: number; slotted?: boolean } = {},
  ): Promise<Map<string, Statement>> {
    const ids = await this.store.claimsCiting([...spanScore.keys()]);
    const claims = (await this.store.getClaims(ids))
      .filter(asked(filter, query.filters))
      .filter((c) => !options.slotted || slotOf(c) !== undefined);
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
      .slice(0, options.limit ?? STATEMENT_POOL);
    const decisions = await this.authz.checkMany(
      who,
      "read",
      ranked.map((x) => ({ type: "claim", id: x.c.id })),
    );
    const allowed = ranked.filter((_, i) => decisions[i]?.allow);
    const cited = allowed.flatMap((x) => supports.get(x.c.id) ?? []);
    const versions = await this.versions(cited.map((e) => e.source_version_id));
    const readable = await this.readableDocuments(who, [...versions.values()]);
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

  async verdictsOf(tenantId: string, claims: readonly Claim[]): Promise<Map<string, SlotVerdict>> {
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
  async visibleVerdicts(
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

  async stalenessOf(tenantId: string, unitIds: readonly string[]): Promise<Map<string, Staleness>> {
    if (!this.staleness || !unitIds.length) return new Map();
    return new Map((await this.staleness.staleness(tenantId, [...new Set(unitIds)])).map((s) => [s.unit_id, s]));
  }

  /**
   * The value that holds takes the place of an outdated or disputed one the question found
   * (among the hits, else among those given): its statement joins the sources when the asker
   * may read it and it passes the search's filters, as the hit of a search, with its freshness.
   */
  async addHeld(
    hits: SearchHit[],
    searched: Searched,
    who: Principal,
    found: readonly SearchHit[] = hits,
  ): Promise<void> {
    const have = new Set(hits.map((h) => h.unit_id));
    const wanted = [
      ...new Set(found.flatMap((h) => (h.held_unit_id && !have.has(h.held_unit_id) ? [h.held_unit_id] : []))),
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
    const versions = await this.versions(evidence.map((e) => e.source_version_id));
    const readable = await this.readableDocuments(who, [...versions.values()]);
    const spans = new Map((await this.store.getSpans(evidence.map((e) => e.span_id))).map((s) => [s.id, s]));
    const staleness = await this.stalenessOf(
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
