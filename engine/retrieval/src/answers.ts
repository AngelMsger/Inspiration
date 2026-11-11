import {
  type AnswerQuery,
  allows,
  type Citation,
  type FreshnessInfo,
  type FreshnessState,
  type GroundedAnswer,
  type IndexFilter,
  type ModelGateway,
  maxLabel,
  newId,
  type Principal,
  parseAs,
  type SearchHit,
  type SensitivityLabel,
  type SourceVersion,
  slotOf,
} from "@inspiration/contracts";
import type { Records } from "@inspiration/eventbus";
import { languageOf, logger } from "@inspiration/kernel";
import { estimateTokens, type PromptRegistry } from "@inspiration/model-gateway";
import {
  disputesOf,
  type Found,
  notesOf,
  passageHit,
  passagesWithoutReplaced,
  type Searched,
  spanScores,
  standingOf,
} from "./hits.ts";
import { DOCUMENTS, documentOf, EDITIONS, type Edition, key } from "./indexing.ts";
import { ANSWERS, type AnswerRecord, costOf, memberOf, metering } from "./metering.ts";
import {
  ANSWER_PROMPT_VERSION,
  ANSWER_SCHEMA,
  ANSWER_TASK,
  type AnswerInput,
  type AnswerOutput,
  type AnswerSource,
  COMPONENT,
  complete,
} from "./protocol.ts";
import { type Baseline, RERANK_POOL, type Search, STATEMENT_POOL } from "./search.ts";
import { fill, packFor } from "./text.ts";

// Answers: the sources an answer reads, the best of what search found, from the latest edition
// of each document, with the values that hold; the model's answer from them, each sentence
// citing them, and notes on disputed and replaced values. Retrieval's doc comment (index.ts)
// describes the behaviour.

const log = logger(COMPONENT);

/** Passages an answer reads, and statements beside them. */
export const ANSWER_SOURCES = 8;
/** How many passages and statements an answer reads, the best of each kind. */
export interface AnswerSources {
  passages: number;
  statements: number;
}

/** Read authorized passages before composing an answer; true requests a refreshed view after reading. */
export type ReadOnUse = (citations: readonly Citation[], who: Principal) => Promise<boolean>;
/**
 * A compact answer: the governed statements found, each a conclusion with the quote behind it,
 * and a few whole passages for what reading missed. It reads about half of what a full
 * answer reads, so a smaller model answers it faster, if what governance kept holds the answer.
 */
export const COMPACT_SOURCES: AnswerSources = { passages: 2, statements: 8 };
/** Passages the mature-RAG baseline reads, where it has no statements beside them. */
export const MATURE_SOURCES = 16;
/** Below this confidence, a statement only one document states is thin evidence. */
export const THIN = 0.6;
/** How far an answer follows editions of editions, and the most documents it looks at. */
const EDITION_HOPS = 3;
const EDITION_DOCUMENTS = 50;
const LEVELS = { search_only: 0, reference: 1, governed: 2 } as const;
/** The most a long-context baseline reads for one answer. */
export const LONG_CONTEXT_TOKENS = 150_000;
const SEVERITY: readonly FreshnessState[] = ["fresh", "aging", "stale", "at_risk"];

/** The documents a long-context baseline would read do not fit one context. */
export class ContextTooLong extends Error {
  override name = "ContextTooLong";
}

/** What answering counts, in Retrieval.totals. */
export interface AnswerTotals {
  answers: number;
}

export class Answers {
  readonly search: Search;
  readonly records: Records;
  readonly models: ModelGateway;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly baseline: Baseline | undefined;
  readonly readAll: boolean;
  readonly contextTokens: number;
  readonly answerSources: AnswerSources;
  readonly totals: AnswerTotals;
  readonly readOnUse: ReadOnUse | undefined;

  constructor(options: {
    search: Search;
    records: Records;
    models: ModelGateway;
    prompts: PromptRegistry;
    clock: () => Date;
    baseline: Baseline | undefined;
    readAll: boolean;
    contextTokens: number;
    answerSources: AnswerSources;
    totals: AnswerTotals;
    readOnUse?: ReadOnUse;
  }) {
    this.search = options.search;
    this.records = options.records;
    this.models = options.models;
    this.prompts = options.prompts;
    this.clock = options.clock;
    this.baseline = options.baseline;
    this.readAll = options.readAll;
    this.contextTokens = options.contextTokens;
    this.answerSources = options.answerSources;
    this.totals = options.totals;
    this.readOnUse = options.readOnUse;
  }

  /**
   * The best passages and, beside them, the best statements, as many of each as
   * `answerSources` says, so a statement never takes the place of a passage; then the values that hold
   * instead of the ones found that do not.
   */
  async sources(query: AnswerQuery, who: Principal): Promise<{ hits: SearchHit[]; searched: Searched }> {
    if (this.baseline === "long_context") return this.#everything(query, who);
    if (this.readAll) return this.#governedEverything(query, who);
    const found = await this.search.find(
      {
        text: query.question,
        top_k: RERANK_POOL + STATEMENT_POOL,
        kinds: ["claim", "chunk"],
        ...(query.space_ids && { space_ids: query.space_ids }),
        ...(query.filters && { filters: query.filters }),
      },
      who,
      true,
    );
    // A rival knows nothing of editions; the knowledge base answers from the latest.
    const replaced = this.baseline ? new Set<string>() : await this.#replaced(found.hits, who);
    const latest = latestEditions(found.hits, replaced);
    const searched = { ...found, hits: bestOfEachKind(latest, this.answerSources) };
    const hits = passagesWithoutReplaced(searched);
    // A replaced edition's statement leaves, and the value that holds in its place still joins.
    const kept = new Set(latest.map((h) => h.unit_id));
    const left = bestOfEachKind(found.hits, this.answerSources).filter((h) => !kept.has(h.unit_id));
    await this.search.addHeld(hits, searched, who, [...hits, ...left]);
    return { hits: latestEditions(hits, replaced), searched };
  }

  /**
   * The versions the hits cite that a later edition the asker can read replaces: one changed
   * later, at no lower governance level and authority, found through the documents' editions
   * as far as they chain (EDITION_HOPS).
   */
  async #replaced(hits: readonly SearchHit[], who: Principal): Promise<Set<string>> {
    const cited = await this.search.versions(hits.flatMap((h) => h.citations.map((c) => c.source_version_id)));
    const found = new Set([...cited.values()].map(documentOf));
    const seen = new Set(found);
    const links: Edition[] = [];
    let frontier = [...found];
    for (let hop = 0; hop < EDITION_HOPS && frontier.length && seen.size < EDITION_DOCUMENTS; hop++) {
      const rows = await this.records.find(EDITIONS, { tenant_id: who.tenant_id, document: frontier });
      links.push(...rows);
      frontier = [...new Set(rows.map((e) => e.other))].filter((d) => !seen.has(d)).slice(0, EDITION_DOCUMENTS);
      for (const d of frontier) seen.add(d);
    }
    if (!links.length) return new Set();
    const indexed = await this.records.getMany(
      DOCUMENTS,
      [...seen].map((d) => key(who.tenant_id, d)),
    );
    const latest = await this.search.versions(indexed.filter((d) => !d.deleted).map((d) => d.source_version_id));
    const current = new Map([...latest.values()].map((v) => [documentOf(v), v]));
    const readable = await this.search.readableDocuments(who, [...latest.values()]);
    // Families of editions, through the pairs whose versions are the ones indexed now.
    const near = new Map<string, string[]>();
    for (const e of links) {
      if (current.get(e.document)?.id !== e.versions[0] || current.get(e.other)?.id !== e.versions[1]) continue;
      near.set(e.document, [...(near.get(e.document) ?? []), e.other]);
    }
    const out = new Set<string>();
    for (const v of cited.values()) {
      const mine = current.get(documentOf(v));
      const family = mine ? [...familyOf(documentOf(mine), near)] : [];
      const later = family.some((d) => {
        const e = current.get(d);
        return e !== undefined && readable.has(e.id) && replaces(e, mine as SourceVersion);
      });
      if (later) out.add(v.id);
    }
    return out;
  }

  /**
   * Every passage the asker may read in the spaces asked for, document by document in
   * reading order. The query's filters are on statements, which a passage is not, as for the
   * mature baseline.
   */
  async #everything(query: AnswerQuery, who: Principal): Promise<{ hits: SearchHit[]; searched: Searched }> {
    const { filter, found } = await this.#all(query, who);
    const tokens = found.reduce((n, f) => n + f.chunk.token_count, 0);
    if (tokens > this.contextTokens) {
      throw new ContextTooLong(`${tokens} tokens in ${found.length} passages, more than ${this.contextTokens}`);
    }
    const now = this.clock().toISOString();
    const hits = found.map((f) => passageHit(f, f.spans, 0, { state: "fresh", as_of: now }));
    const labels = new Map(found.map((f): [string, SensitivityLabel] => [f.chunk.id, f.chunk.sensitivity]));
    return { hits, searched: { hits, statements: new Map(), verdicts: new Map(), filter, labels } };
  }

  /**
   * Everything the asker may read, after governance, as an answer from search reads what it
   * found: the latest editions only, without the sentences that state only values that no
   * longer hold, each value that does not hold marked and the one that does beside it.
   */
  async #governedEverything(query: AnswerQuery, who: Principal): Promise<{ hits: SearchHit[]; searched: Searched }> {
    const { filter, found } = await this.#all(query, who);
    const statements = await this.search.statements(spanScores(found), new Set(), who, filter, query, {
      limit: Number.POSITIVE_INFINITY,
      slotted: true,
    });
    const verdicts = await this.search.visibleVerdicts(
      who,
      await this.search.verdictsOf(
        who.tenant_id,
        [...statements.values()].map((s) => s.claim),
      ),
      statements.values(),
    );
    for (const s of statements.values()) {
      const slot = slotOf(s.claim);
      if (slot) s.verdict = verdicts.get(slot);
    }
    const now = this.clock().toISOString();
    const passages = found.map((f) => passageHit(f, f.spans, 0, { state: "fresh", as_of: now }));
    const labels = new Map<string, SensitivityLabel>([
      ...found.map((f): [string, SensitivityLabel] => [f.chunk.id, f.chunk.sensitivity]),
      ...[...statements.values()].map((s): [string, SensitivityLabel] => [s.claim.id, s.claim.sensitivity]),
    ]);
    const replaced = await this.#replaced(passages, who);
    const searched: Searched = {
      hits: latestEditions(passages, replaced),
      statements,
      verdicts,
      filter,
      ...(query.filters && { filters: query.filters }),
      labels,
    };
    const hits = passagesWithoutReplaced(searched);
    await this.search.addHeld(hits, searched, who);
    const out = latestEditions(hits, replaced);
    const tokens = out.reduce((n, h) => n + h.token_estimate, 0);
    if (tokens > this.contextTokens) {
      throw new ContextTooLong(
        `${tokens} tokens in ${out.length} sources after governance, more than ${this.contextTokens}`,
      );
    }
    return { hits: out, searched };
  }

  /** Every passage the asker may read in the spaces asked for, document by document in reading order. */
  async #all(query: AnswerQuery, who: Principal): Promise<{ filter: IndexFilter; found: Found[] }> {
    const filter = await this.search.scope(who, query.space_ids);
    const spaces = new Set(filter.space_ids);
    const ids = spaces.size
      ? (await this.records.find(DOCUMENTS, { tenant_id: who.tenant_id })).flatMap((d) => d.chunk_ids)
      : [];
    // Every passage counts as found alike, so each statement it states counts as found.
    const found = (
      await this.search.readable(
        ids.map((id): [string, number] => [id, 0.01]),
        who,
      )
    ).filter((f) => spaces.has(f.chunk.space_id) && allows(filter.max_sensitivity, f.chunk.sensitivity));
    return { filter, found };
  }

  /**
   * The answer, recorded with how long it took, what its model calls cost, the member it was
   * for and the spaces it read (metering.ts). A record that cannot be written is logged and
   * the answer still given.
   */
  async answer(q: AnswerQuery, who: Principal): Promise<GroundedAnswer> {
    const query = parseAs<AnswerQuery>("AnswerQuery", q);
    this.totals.answers++;
    const at = this.clock().toISOString();
    const started = performance.now();
    const { value, calls } = await metering(() => this.#answer(query, who));
    const cost = costOf(calls);
    const record: AnswerRecord = {
      answer_id: value.answer.answer_id,
      tenant_id: who.tenant_id,
      member_id: memberOf(who) ?? who.id,
      ...(who.kind === "agent" && { agent_id: who.id }),
      at,
      month: at.slice(0, 7),
      ms: Math.round(performance.now() - started),
      space_ids: [...new Set(value.read.flatMap((h) => (h.space_id ? [h.space_id] : [])))].sort(),
      ...(cost && { cost }),
      calls,
      reads: this.readAll || this.baseline === "long_context" ? "everything" : { ...this.answerSources },
      ...(this.baseline && { baseline: this.baseline }),
    };
    try {
      await this.records.transaction((tx) => tx.put(ANSWERS, [record]));
    } catch (e) {
      log.warn("answer not recorded", { answer_id: record.answer_id, error: String(e) });
    }
    return value.answer;
  }

  /** The answer, and the sources it read. */
  async #answer(query: AnswerQuery, who: Principal): Promise<{ answer: GroundedAnswer; read: SearchHit[] }> {
    const language = languageOf(query.question);
    const pack = packFor(language);
    let selected = await this.sources(query, who);
    if (
      await this.readOnUse?.(
        selected.hits.flatMap((h) => h.citations),
        who,
      )
    ) {
      // Reuse the normal authorized retrieval path after reading changes claims or standing.
      selected = await this.sources(query, who);
    }
    const { hits, searched } = selected;
    const refOf = new Map(hits.map((h, i) => [h.unit_id, String(i + 1)]));
    const versions = await this.search.versions(
      hits.flatMap((h) => (h.kind === "chunk" ? h.citations.slice(0, 1).map((c) => c.source_version_id) : [])),
    );
    const disputes = disputesOf(hits, searched);
    const sources: AnswerSource[] = hits.map((h, i) => {
      const held = h.held_unit_id && refOf.get(h.held_unit_id);
      const disputed = disputes.get(h.unit_id)?.map((id) => refOf.get(id) as string);
      const version = h.kind === "chunk" ? versions.get(h.citations[0]?.source_version_id ?? "") : undefined;
      const changed = version?.version.modified_at?.slice(0, 10);
      return {
        ref: String(i + 1),
        kind: h.kind === "claim" ? "statement" : "passage",
        title: h.title,
        text: h.kind === "claim" ? h.snippet : h.citations.map((c) => c.quote).join("\n"),
        ...(h.standing && { standing: h.standing }),
        ...(held && { held_ref: held }),
        ...(disputed && (h.kind === "claim" ? { disputed_with: disputed } : { disputed })),
        ...(version && { level: version.governance_level ?? "governed" }),
        ...(changed && { changed }),
      };
    });
    const now = this.clock().toISOString();
    if (!sources.length) {
      const answer: GroundedAnswer = {
        answer_id: newId("request"),
        answer: pack.text("nothing"),
        citations: [],
        confidence: 0,
        gaps: [query.question],
        freshness: { state: "fresh", as_of: now },
        token_estimate: estimateTokens(pack.text("nothing")),
      };
      return { answer, read: hits };
    }
    // The question is labelled internal, as anything a member writes; the sources as they are.
    const sensitivity = maxLabel("internal", ...hits.map((h) => searched.labels.get(h.unit_id) ?? "internal"));
    // Sources first, so prompts with the same sources share their prefix (AnswerInput).
    const input: AnswerInput = {
      sources,
      language,
      ...(query.context && { context: query.context }),
      question: query.question,
    };
    const output = await complete<AnswerOutput>(this.models, this.prompts, {
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
    const given: GroundedAnswer = {
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
    return { answer: given, read: hits };
  }
}

// ---------------------------------------------------------------- helpers

/** The first hits of each kind, as many as `sources` says, in order: a statement never takes a passage's place. */
function bestOfEachKind(hits: readonly SearchHit[], sources: AnswerSources): SearchHit[] {
  const taken = new Map<string, number>();
  return hits.filter((h) => {
    const k = taken.get(h.kind) ?? 0;
    taken.set(h.kind, k + 1);
    return k < (h.kind === "chunk" ? sources.passages : sources.statements);
  });
}

/** The documents linked to one through editions, however far. */
function familyOf(document: string, near: ReadonlyMap<string, readonly string[]>): Set<string> {
  const family = new Set([document]);
  for (const d of family) for (const e of near.get(d) ?? []) family.add(e);
  return family;
}

/**
 * Whether edition a replaces edition b: it changed later, by the dates the sources give, and
 * is no less trusted, so a newer draft in someone's folder never replaces the governed policy.
 */
function replaces(a: SourceVersion, b: SourceVersion): boolean {
  const [x, y] = [Date.parse(a.version.modified_at ?? ""), Date.parse(b.version.modified_at ?? "")];
  const level = (v: SourceVersion) => LEVELS[v.governance_level ?? "governed"];
  return x > y && level(a) >= level(b) && a.authority >= b.authority;
}

/**
 * The hits without what later editions replace: a replaced edition's passages are left out,
 * and so are statements only replaced editions state, whatever their standing; a value that
 * left the latest edition is no longer stated. Other statements cite the latest editions.
 */
function latestEditions(hits: readonly SearchHit[], replaced: ReadonlySet<string>): SearchHit[] {
  if (!replaced.size) return [...hits];
  return hits.flatMap((h) => {
    const kept = h.citations.filter((c) => !replaced.has(c.source_version_id));
    if (kept.length === h.citations.length) return [h];
    return kept.length ? [{ ...h, citations: kept }] : [];
  });
}
