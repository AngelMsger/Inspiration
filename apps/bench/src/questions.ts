/**
 * The question check: questions.yaml beside a corpus asks questions in any language, as the
 * corpus's reader, and says what a right answer contains and which documents it cites. Each
 * answer is right when it contains one of the expected texts, and cited right when one of
 * its citations is in one of the expected documents (a path without its language suffix
 * matches every translation: "docs/a" matches docs/a.html and docs/a.ja.html). A question
 * with `answer: null` has no answer in the corpus: it is right when nothing is cited and
 * the question comes back as a gap.
 *
 * A question can instead name a fact of keys.yaml, which gives each fact's values by the day
 * each took effect, and where the corpus states each: the file, its revision and the words.
 * The value in effect on the key's `asked_on` day is the answer; texts of the others are
 * stale, and an answer that gives one of them without the value in effect is `stale`. A fact
 * that has had one value is `unchanged`, one that has had more is `changed`, and one stated
 * on that day by no document in use is `not_stated` (old copies may still state it). Texts
 * match without case or thousands separators, and a number only whole: "30" is not in "300".
 * Totals are given by kind and by the question's language, for the engine and the rivals.
 *
 * Each question is also checked for whether the search the answer rests on found an expected
 * text at all (`found`): with stand-ins for the models, a right source the stand-in answer
 * leaves out is the stand-in's miss, a source never found is retrieval's. And each is asked
 * the other ways over the same documents and model (`baselines`): a mature RAG over the same
 * chunks and search, without statements or governance; a model that reads every document,
 * when they fit one context; and the knowledge base reading every document after
 * governance, when they fit. How long each answer took is kept beside it (`latency`): the
 * whole call, the answering model's share and the reranker's.
 *
 * Like the control check, each question may record where the engine answers it otherwise
 * today and why (`engine`), and the test holds the run to it.
 *
 * What the model calls of each path cost is reported too (`cost`), and the latencies' median
 * and 90th percentile (`latency`); sampleQuestions picks a spread of the questions for a
 * quick run.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GroundedAnswer, type SearchHit, schemaErrors, type UsageRecord } from "@inspiration/contracts";
import type { Corpus, Engine } from "@inspiration/engine";
import { languageOf } from "@inspiration/kernel";
import { Gateway } from "@inspiration/model-gateway";
import { ANSWER_TASK, ContextTooLong, type Retrieval } from "@inspiration/retrieval";
import { parse } from "yaml";
import { usageMark } from "./claims.ts";
import { type Spend, spendLine, spendOf, usageSince } from "./cost.ts";

/**
 * How an answer turned out: right, a value no longer in effect, a wrong text, wrong
 * citations, both, or nothing answered.
 */
export type Outcome = "right" | "stale" | "wrong_answer" | "wrong_citations" | "wrong" | "unanswered";
const OUTCOMES: readonly Outcome[] = ["right", "stale", "wrong_answer", "wrong_citations", "wrong", "unanswered"];

/** What a question asks about: a fact that has had one value, one that has had more, or one not stated. */
export type Kind = "unchanged" | "changed" | "not_stated";
const KINDS: readonly Kind[] = ["unchanged", "changed", "not_stated"];

export interface Question {
  question: string;
  /** Texts one of which a right answer contains; null when nothing in the corpus answers it. */
  answer: string[] | null;
  /** Texts of values no longer in effect: an answer with one of them and none of answer's is stale. */
  stale?: string[];
  /** Documents (corpus paths, a language suffix optional) one of which a right answer cites. */
  cites?: string[];
  /** The fact of keys.yaml it asks about. */
  fact?: string;
  kind: Kind;
  /** Where the engine answers it otherwise today, and why. */
  engine?: { outcome: Outcome; why: string };
}

/** keys.yaml: each fact's values by the day each took effect, and where the corpus states each. */
export interface Keys {
  /** The day the questions are asked: the value in effect then is the answer. */
  asked_on: string;
  facts: Record<string, FactKey>;
}

export interface FactKey {
  /** What the fact is, in a few words. */
  about: string;
  /** In order of the day each took effect. */
  values: KeyValue[];
}

export interface KeyValue {
  /** The day the value took effect, as the documents or their history show it. */
  from: string;
  /** As the vocabulary normalizes it; null from the day no document in use states it. */
  value: string | null;
  /** Texts one of which an answer giving this value contains. */
  texts?: string[];
  /** Where the corpus states it: the file (a corpus path), its revision, and the words, verbatim. */
  stated: { file: string; revision: string; quote: string }[];
}

export class QuestionsError extends Error {
  override name = "QuestionsError";
}

const ENGINE = {
  type: "object",
  required: ["outcome", "why"],
  additionalProperties: false,
  properties: { outcome: { enum: OUTCOMES }, why: { type: "string" } },
};

const SCHEMA = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            required: ["question", "answer"],
            additionalProperties: false,
            properties: {
              question: { type: "string", minLength: 1 },
              answer: { anyOf: [{ type: "null" }, { type: "array", items: { type: "string" }, minItems: 1 }] },
              cites: { type: "array", items: { type: "string" } },
              engine: ENGINE,
            },
          },
          {
            type: "object",
            required: ["fact", "ask"],
            additionalProperties: false,
            properties: {
              fact: { type: "string", minLength: 1 },
              ask: {
                type: "array",
                minItems: 1,
                items: {
                  anyOf: [
                    { type: "string", minLength: 1 },
                    {
                      type: "object",
                      required: ["question"],
                      additionalProperties: false,
                      properties: { question: { type: "string", minLength: 1 }, engine: ENGINE },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  },
};

const DAY = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

const KEYS_SCHEMA = {
  type: "object",
  required: ["asked_on", "facts"],
  additionalProperties: false,
  properties: {
    asked_on: DAY,
    facts: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["about", "values"],
        additionalProperties: false,
        properties: {
          about: { type: "string", minLength: 1 },
          values: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["from", "value", "stated"],
              additionalProperties: false,
              properties: {
                from: DAY,
                value: { type: ["string", "null"] },
                texts: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
                stated: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["file", "revision", "quote"],
                    additionalProperties: false,
                    properties: {
                      file: { type: "string", minLength: 1 },
                      revision: { type: "string", minLength: 1 },
                      quote: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

type Entry =
  | { question: string; answer: string[] | null; cites?: string[]; engine?: Question["engine"] }
  | { fact: string; ask: (string | { question: string; engine?: Question["engine"] })[] };

async function readYaml(dir: string, name: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
  return parse(text);
}

export async function loadKeys(dir: string): Promise<Keys | undefined> {
  const data = (await readYaml(dir, "keys.yaml")) as Keys | undefined;
  if (data === undefined) return undefined;
  const errors = schemaErrors(KEYS_SCHEMA, data);
  for (const [fact, key] of Object.entries(data.facts ?? {})) {
    key.values.forEach((v, i) => {
      if (i && v.from <= (key.values[i - 1] as KeyValue).from) errors.push(`${fact}: values out of order`);
      if (v.value !== null && (!v.texts || !v.stated.length)) errors.push(`${fact}: ${v.value} needs texts and stated`);
    });
  }
  if (errors.length) throw new QuestionsError(`keys.yaml: ${errors.join("; ")}`);
  return data;
}

/** The value of a fact in effect on the day: the last that took effect on or before it. */
export function valueOn(key: FactKey, day: string): KeyValue | undefined {
  return key.values.filter((v) => v.from <= day).at(-1);
}

/** The questions a fact entry asks, with the answer, stale texts and documents its key gives. */
function expand(entry: Extract<Entry, { fact: string }>, keys: Keys | undefined): Question[] {
  const key = keys?.facts[entry.fact];
  if (!keys || !key) throw new QuestionsError(`questions.yaml: no key for ${entry.fact} in keys.yaml`);
  const now = valueOn(key, keys.asked_on);
  const answer = now?.value != null ? (now.texts as string[]) : null;
  const stale = [...new Set(key.values.filter((v) => v !== now).flatMap((v) => v.texts ?? []))].filter(
    (t) => !answer?.includes(t),
  );
  const kind: Kind =
    answer === null ? "not_stated" : new Set(key.values.map((v) => v.value)).size > 1 ? "changed" : "unchanged";
  const cites = answer && [...new Set(now?.stated.map((s) => s.file))];
  return entry.ask.map((a) => {
    const { question, engine } = typeof a === "string" ? { question: a, engine: undefined } : a;
    return {
      question,
      answer,
      ...(stale.length && { stale }),
      ...(cites && { cites }),
      fact: entry.fact,
      kind,
      ...(engine && { engine }),
    };
  });
}

export async function loadQuestions(dir: string): Promise<Question[] | undefined> {
  const data = (await readYaml(dir, "questions.yaml")) as { questions: Entry[] } | undefined;
  if (data === undefined) return undefined;
  const errors = schemaErrors(SCHEMA, data);
  if (errors.length) throw new QuestionsError(`questions.yaml: ${errors.join("; ")}`);
  const keys = data.questions.some((e) => "fact" in e) ? await loadKeys(dir) : undefined;
  return data.questions.flatMap((e) =>
    "fact" in e ? expand(e, keys) : [{ ...e, kind: e.answer === null ? "not_stated" : "unchanged" } as Question],
  );
}

export interface QuestionResult {
  question: string;
  fact?: string;
  kind: Kind;
  language: Language;
  outcome: Outcome;
  /** What the run's outcome should be: the engine entry's, else right. */
  expected: Outcome;
  answer: string;
  /** Whether a source the answer was given states an expected text; null for no answer. */
  found: boolean | null;
  /** How the other ways answer it; a long context is null when the documents do not fit. */
  baselines: { mature: Rival; long_context: Rival | null; governed_long_context: Rival | null };
  cited: string[];
  notes: string[];
  confidence: number;
  latency: Latency;
}

export interface Rival {
  outcome: Outcome;
  answer: string;
  cited: string[];
  latency: Latency;
}

/** How long an answer took, in milliseconds: the whole call, and what its model calls took. */
export interface Latency {
  ms: number;
  /** The answering model's calls. */
  model_ms: number;
  /** The reranker's calls; a reranker on this machine's CPU is far slower than one on a GPU. */
  rerank_ms: number;
}

/** The ways of answering a question, the engine's first. */
export const PATHS = ["engine", "mature", "long_context", "governed_long_context"] as const;
export type Path = (typeof PATHS)[number];
const NAMES: Record<Path, string> = {
  engine: "engine",
  mature: "mature RAG",
  long_context: "reading everything",
  governed_long_context: "reading everything after governance",
};

/** The median and 90th percentile of a path's latencies, in milliseconds. */
export interface LatencySummary {
  answers: number;
  median_ms: number;
  p90_ms: number;
  model_median_ms: number;
  model_p90_ms: number;
  rerank_median_ms: number;
}

export type Language = ReturnType<typeof languageOf>;

/** Answers right and stale, of the engine and each other way; a long context null when it could not run. */
export interface Tally {
  questions: number;
  engine: Score;
  mature: Score;
  long_context: Score | null;
  governed_long_context: Score | null;
}

export interface Score {
  right: number;
  stale: number;
}

export interface QuestionsReport {
  questions: QuestionResult[];
  totals: {
    questions: number;
    right: number;
    stale: number;
    as_recorded: number;
    cited_right: number;
    /** Questions with an answer whose search found an expected text. */
    found: number;
    notes: number;
    /** Questions each other way answers right; null when it could not run. */
    baselines: { mature: number; long_context: number | null; governed_long_context: number | null };
    by_kind: Partial<Record<Kind, Tally>>;
    by_language: Partial<Record<Language, Tally>>;
    /** Each path's latencies, of the questions it answered. */
    latency: Partial<Record<Path, LatencySummary>>;
  };
  /** What each path's model calls cost, in the gateway's currency; absent without an in-process gateway. */
  cost?: { currency: string } & Record<Path, Spend>;
}

/**
 * n questions spread evenly over the list, which questions.yaml orders by fact and language,
 * so a sample keeps their mix; all of them when n is not smaller.
 */
export function sampleQuestions(questions: readonly Question[], n: number): Question[] {
  if (n >= questions.length) return [...questions];
  return Array.from({ length: n }, (_, i) => questions[Math.floor((i * questions.length) / n)] as Question);
}

/** The path without its language suffix and extension: docs/a.zh-cn.html is docs/a. */
const stem = (path: string) => path.replace(/(\.[a-z]{2}(-[a-z]{2,4})?)?\.[a-z0-9]+$/i, "");

/** Lower case, without thousands separators or runs of spaces: "$5,000  USD" is "$5000 usd". */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/(\d)[,\uff0c](?=\d{3}(?!\d))/g, "$1")
    .replace(/\s+/g, " ");
const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Whether the text says any of the texts, a number only whole: "30" is not in "300", "1.30"
 * or "30.5", but "100" is in "$100.00".
 */
export function says(text: string, texts: readonly string[] | undefined): boolean {
  const hay = plain(text);
  return (texts ?? []).some((t) => {
    const p = plain(t);
    const edge = `${/^\d/.test(p) ? "(?<![\\d.])" : ""}${p.replace(SPECIAL, "\\$&")}${/\d$/.test(p) ? "(?!\\d|[.,]\\d*[1-9])" : ""}`;
    return new RegExp(edge).test(hay);
  });
}

function outcomeOf(q: Question, a: GroundedAnswer, cited: readonly string[]): Outcome {
  const said = says(a.answer, q.answer ?? []);
  if (!said && says(a.answer, q.stale)) return "stale";
  if (q.answer === null) return a.citations.length === 0 && a.gaps.length > 0 ? "right" : "wrong_answer";
  if (!a.citations.length) return "unanswered";
  const cites = !q.cites?.length || cited.some((p) => q.cites?.some((c) => stem(p) === stem(c) || p === c));
  if (said && cites) return "right";
  if (said) return "wrong_citations";
  return cites ? "wrong_answer" : "wrong";
}

/** What the answering model's and the reranker's calls took, of the calls an answer made. */
function modelLatency(used: readonly UsageRecord[]): Omit<Latency, "ms"> {
  const sum = (keep: (u: UsageRecord) => boolean) => used.filter(keep).reduce((n, u) => n + u.latency_ms, 0);
  return {
    model_ms: sum((u) => u.operation === "complete" && u.task === ANSWER_TASK),
    rerank_ms: sum((u) => u.operation === "rerank"),
  };
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

function latencyOf(of: readonly Latency[]): LatencySummary {
  return {
    answers: of.length,
    median_ms: percentile(
      of.map((l) => l.ms),
      50,
    ),
    p90_ms: percentile(
      of.map((l) => l.ms),
      90,
    ),
    model_median_ms: percentile(
      of.map((l) => l.model_ms),
      50,
    ),
    model_p90_ms: percentile(
      of.map((l) => l.model_ms),
      90,
    ),
    rerank_median_ms: percentile(
      of.map((l) => l.rerank_ms),
      50,
    ),
  };
}

/** Answers right of a way that answered every question; null when it could not answer one. */
const rightOrNull = (rivals: readonly (Rival | null)[]) =>
  rivals.some((r) => r === null) ? null : rivals.filter((r) => r?.outcome === "right").length;

export async function questionsReport(
  engine: Engine,
  corpus: Corpus,
  questions: readonly Question[],
): Promise<QuestionsReport> {
  const results: QuestionResult[] = [];
  const pathsOf = async (a: GroundedAnswer): Promise<string[]> => {
    const versions = await Promise.all(
      [...new Set(a.citations.map((c) => c.source_version_id))].map((id) => engine.store.getSourceVersion(id)),
    );
    const pathOf = new Map(
      versions.flatMap((v) => (v ? [[v.id, corpus.pathOf(v.source_id, v.external_id)] as const] : [])),
    );
    return [...new Set(a.citations.map((c) => pathOf.get(c.source_version_id) ?? c.source_title))];
  };
  const spent = Object.fromEntries(PATHS.map((p) => [p, [] as UsageRecord[]])) as Record<Path, UsageRecord[]>;
  /** The call, its usage counted against the path, and how long it and its model calls took. */
  const metered = async <T>(path: Path, call: () => Promise<T>): Promise<{ value: T; latency: Latency }> => {
    const from = usageMark(engine);
    const started = performance.now();
    try {
      const value = await call();
      const ms = Math.round(performance.now() - started);
      return { value, latency: { ms, ...modelLatency(usageSince(engine, from)) } };
    } finally {
      spent[path].push(...usageSince(engine, from));
    }
  };
  for (const q of questions) {
    const own = await metered("engine", () => engine.retrieval.answer({ question: q.question }, corpus.reader));
    const a = own.value;
    const sources = await engine.retrieval.sources({ question: q.question }, corpus.reader);
    const expected = q.answer;
    // The same reading of a text as the answer's, so "5000" in a source is "5,000" found.
    const found = expected && sources.some((h) => says(h.snippet, expected));
    const cited = await pathsOf(a);
    const rival = async (path: Exclude<Path, "engine">, retrieval: Retrieval): Promise<Rival | null> => {
      try {
        const { value: answer, latency } = await metered(path, () =>
          retrieval.answer({ question: q.question }, corpus.reader),
        );
        const paths = await pathsOf(answer);
        return { outcome: outcomeOf(q, answer, paths), answer: answer.answer, cited: paths, latency };
      } catch (e) {
        if (e instanceof ContextTooLong) return null;
        throw e;
      }
    };
    const mature = (await rival("mature", engine.baselines.mature)) as Rival;
    const longContext = await rival("long_context", engine.baselines.long_context);
    const governedLongContext = await rival("governed_long_context", engine.governedLongContext);
    results.push({
      question: q.question,
      ...(q.fact && { fact: q.fact }),
      kind: q.kind,
      language: languageOf(q.question),
      outcome: outcomeOf(q, a, cited),
      expected: q.engine?.outcome ?? "right",
      answer: a.answer,
      found: expected ? Boolean(found) : null,
      baselines: { mature, long_context: longContext, governed_long_context: governedLongContext },
      cited,
      notes: (a.notes ?? []).map((n) => `${n.kind}: ${n.text}`),
      confidence: a.confidence,
      latency: own.latency,
    });
  }
  return {
    questions: results,
    totals: {
      questions: results.length,
      right: results.filter((r) => r.outcome === "right").length,
      stale: results.filter((r) => r.outcome === "stale").length,
      as_recorded: results.filter((r) => r.outcome === r.expected).length,
      cited_right: results.filter((r) => r.outcome === "right" || r.outcome === "wrong_answer").length,
      found: results.filter((r) => r.found).length,
      notes: results.reduce((n, r) => n + r.notes.length, 0),
      baselines: {
        mature: results.filter((r) => r.baselines.mature.outcome === "right").length,
        long_context: rightOrNull(results.map((r) => r.baselines.long_context)),
        governed_long_context: rightOrNull(results.map((r) => r.baselines.governed_long_context)),
      },
      by_kind: tallies(results, (r) => r.kind),
      by_language: tallies(results, (r) => r.language),
      latency: Object.fromEntries(
        PATHS.flatMap((p) => {
          const of = results.flatMap((r) => {
            const latency = p === "engine" ? r.latency : r.baselines[p]?.latency;
            return latency ? [latency] : [];
          });
          return of.length ? [[p, latencyOf(of)]] : [];
        }),
      ),
    },
    ...(engine.models instanceof Gateway && {
      cost: {
        currency: engine.models.config.currency,
        ...(Object.fromEntries(PATHS.map((p) => [p, spendOf(spent[p])])) as Record<Path, Spend>),
      },
    }),
  };
}

/** How deep search goes for --search-only: the most hits a search returns. */
export const SEARCH_DEPTH = 100;
/** The depths searchReport counts the first hit that states an expected text within. */
export const DEPTHS = [8, 16, 30, 60, SEARCH_DEPTH] as const;
/** The numbers of documents searchReport counts the first one that states it within. */
export const DOCUMENT_DEPTHS = [1, 3, 5, 10, 20] as const;

/** Where search put a question's answer, without asking any model to answer it. */
export interface SearchResult {
  question: string;
  fact?: string;
  kind: Kind;
  language: Language;
  /**
   * Whether the hits the engine's answer reads state an expected text as the model is given
   * them: a statement whole, and a passage whole too, since answers read passages whole. Null
   * for a question with no answer.
   */
  found: boolean | null;
  /**
   * The same hits, each passage's text read from the store. Equal to `found` now that answers
   * read passages whole; it measured what whole passages would add when answers read snippets.
   */
  found_whole: boolean | null;
  /** The mature RAG's hits as its model is given them. */
  found_by_mature: boolean | null;
  /** The place, from 1, of the first hit of one wide search that states it, read whole; null when none does. */
  rank: number | null;
  /** The place, from 1, of the first document of that search's hits, in their order, whose text states it. */
  document_rank: number | null;
}

export interface SearchTally {
  /** Questions with an answer. */
  questions: number;
  found: number;
  found_whole: number;
  found_by_mature: number;
  /** Questions whose first hit with an expected text is within each of DEPTHS. */
  within: Record<string, number>;
  /** Questions whose first document with an expected text is within each of DOCUMENT_DEPTHS. */
  within_documents: Record<string, number>;
}

export interface SearchReport {
  questions: SearchResult[];
  totals: SearchTally & {
    by_kind: Partial<Record<Kind, SearchTally>>;
    by_language: Partial<Record<Language, SearchTally>>;
  };
}

/**
 * The question check's search alone, for a change to search that should not pay for answers.
 * For each question with an answer: whether the hits the engine's answer reads state an
 * expected text as its model is given them (each passage whole, which is what `found` checks
 * in questionsReport), and with each passage's text read from the store; the same for plain
 * retrieval; how deep in one wide search the first hit stating it is; and how many documents
 * of that search's hits, taken in order and read whole, come before one that states it, as
 * for an answer that reads the documents search finds.
 */
export async function searchReport(
  engine: Engine,
  corpus: Corpus,
  questions: readonly Question[],
): Promise<SearchReport> {
  const tenantId = corpus.reader.tenant_id;
  const indexed = (await engine.retrieval.documents(tenantId)).filter((d) => !d.deleted);
  const documentOf = new Map<string, string>();
  const documentText = new Map<string, string>();
  for (const d of indexed) {
    const chunks = await engine.store.getChunks(d.chunk_ids);
    for (const c of chunks) documentOf.set(c.id, d.document);
    documentText.set(d.document, chunks.map((c) => c.text).join("\n"));
  }
  const passageText = new Map<string, string>();
  const wholeText = async (hits: readonly SearchHit[]): Promise<string[]> => {
    const missing = hits.filter((h) => h.kind === "chunk" && !passageText.has(h.unit_id)).map((h) => h.unit_id);
    for (const c of missing.length ? await engine.store.getChunks(missing) : []) passageText.set(c.id, c.text);
    return hits.map((h) => (h.kind === "chunk" ? (passageText.get(h.unit_id) ?? h.snippet) : h.snippet));
  };
  const versionDocument = async (h: SearchHit): Promise<string | undefined> => {
    if (h.kind === "chunk") return documentOf.get(h.unit_id);
    const id = h.citations[0]?.source_version_id;
    const v = id ? await engine.store.getSourceVersion(id) : undefined;
    return v && `${v.source_id}:${v.external_id}`;
  };
  const results: SearchResult[] = [];
  for (const q of questions) {
    const expected = q.answer;
    // One after another, so the later searches find the first one's rerank scores in the cache
    // instead of a CPU reranker scoring the same passages three times at once.
    const sources = await engine.retrieval.sources({ question: q.question }, corpus.reader);
    const mature = await engine.baselines.mature.sources({ question: q.question }, corpus.reader);
    const wide = await engine.retrieval.search(
      { text: q.question, top_k: SEARCH_DEPTH, kinds: ["claim", "chunk"] },
      corpus.reader,
    );
    const any = (texts: readonly string[]) => (expected ? texts.some((t) => says(t, expected)) : null);
    const wideText = await wholeText(wide.hits);
    const at = expected ? wideText.findIndex((t) => says(t, expected)) : -1;
    let documentRank: number | null = null;
    if (expected) {
      const seen: string[] = [];
      for (const h of wide.hits) {
        const d = await versionDocument(h);
        if (!d || seen.includes(d)) continue;
        seen.push(d);
        if (says(documentText.get(d) ?? "", expected)) {
          documentRank = seen.length;
          break;
        }
      }
    }
    results.push({
      question: q.question,
      ...(q.fact && { fact: q.fact }),
      kind: q.kind,
      language: languageOf(q.question),
      found: any(sources.map((h) => h.snippet)),
      found_whole: any(await wholeText(sources)),
      found_by_mature: any(mature.map((h) => h.snippet)),
      rank: at < 0 ? null : at + 1,
      document_rank: documentRank,
    });
  }
  const tally = (of: readonly SearchResult[]): SearchTally => {
    const answered = of.filter((r) => r.found !== null);
    const within = (depths: readonly number[], rank: (r: SearchResult) => number | null) =>
      Object.fromEntries(
        depths.map((d) => [String(d), answered.filter((r) => (rank(r) ?? Number.POSITIVE_INFINITY) <= d).length]),
      );
    return {
      questions: answered.length,
      found: answered.filter((r) => r.found).length,
      found_whole: answered.filter((r) => r.found_whole).length,
      found_by_mature: answered.filter((r) => r.found_by_mature).length,
      within: within(DEPTHS, (r) => r.rank),
      within_documents: within(DOCUMENT_DEPTHS, (r) => r.document_rank),
    };
  };
  const by = <K extends string>(keyOf: (r: SearchResult) => K) => {
    const out: Partial<Record<K, SearchTally>> = {};
    for (const k of [...new Set(results.map(keyOf))].sort()) out[k] = tally(results.filter((r) => keyOf(r) === k));
    return out;
  };
  return {
    questions: results,
    totals: { ...tally(results), by_kind: by((r) => r.kind), by_language: by((r) => r.language) },
  };
}

export function searchLines(r: SearchReport): string[] {
  const depths = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([d, n]) => `${d}: ${n}`)
      .join(", ");
  const line = (name: string, t: SearchTally) => [
    `  ${name}: ${t.questions} with an answer; the engine's answer is given it for ${t.found} (${t.found_whole} with each passage read from the store); the mature RAG's for ${t.found_by_mature}`,
    `    first hit stating it within ${depths(t.within)}; first document within ${depths(t.within_documents)}`,
  ];
  const lines = ["search only, no answers:", ...line("all", r.totals)];
  for (const [k, t] of Object.entries(r.totals.by_kind)) lines.push(...line(k.replace("_", " "), t as SearchTally));
  for (const [l, t] of Object.entries(r.totals.by_language)) lines.push(...line(`in ${l}`, t as SearchTally));
  for (const q of r.questions) {
    if (q.found === null) continue;
    const mark = q.found ? "given" : q.found_whole ? "in passage" : "missed";
    const where = q.rank === null ? `no hit in the first ${SEARCH_DEPTH}` : `first hit ${q.rank}`;
    const document = q.document_rank === null ? "no document" : `document ${q.document_rank}`;
    lines.push(`  ${mark.padEnd(10)} ${q.question} (${where}, ${document})`);
  }
  return lines;
}

function tallies<K extends string>(results: readonly QuestionResult[], keyOf: (r: QuestionResult) => K) {
  const score = (outcomes: (Outcome | undefined)[]): Score => ({
    right: outcomes.filter((o) => o === "right").length,
    stale: outcomes.filter((o) => o === "stale").length,
  });
  const by: Partial<Record<K, Tally>> = {};
  for (const k of [...new Set(results.map(keyOf))].sort()) {
    const of = results.filter((r) => keyOf(r) === k);
    const fit = (path: "long_context" | "governed_long_context") =>
      of.some((r) => r.baselines[path] === null) ? null : score(of.map((r) => r.baselines[path]?.outcome));
    by[k] = {
      questions: of.length,
      engine: score(of.map((r) => r.outcome)),
      mature: score(of.map((r) => r.baselines.mature.outcome)),
      long_context: fit("long_context"),
      governed_long_context: fit("governed_long_context"),
    };
  }
  return by;
}

export function questionLines(r: QuestionsReport): string[] {
  const t = r.totals;
  const answerable = r.questions.filter((q) => q.found !== null).length;
  const lines = [
    `questions: ${t.questions}, ${t.right} answered right, ${t.stale} with a value no longer in effect, ${t.as_recorded - t.right} otherwise as recorded, ${t.questions - t.as_recorded} otherwise`,
    `  search found an expected text for ${t.found} of ${answerable} questions with an answer`,
    `  over the same documents and model, a mature RAG answers ${t.baselines.mature} right, a model reading every document ${t.baselines.long_context ?? "(they do not fit)"}, reading every document after governance ${t.baselines.governed_long_context ?? "(they do not fit)"}`,
    ...PATHS.flatMap((p) => {
      const l = t.latency[p];
      return l
        ? [
            `  latency of ${NAMES[p]}: median ${l.median_ms} ms, p90 ${l.p90_ms} ms; answering model median ${l.model_median_ms} ms, p90 ${l.model_p90_ms} ms; reranker median ${l.rerank_median_ms} ms`,
          ]
        : [];
    }),
    ...(r.cost
      ? [
          "  answering cost:",
          ...PATHS.map(
            (p) => `    ${NAMES[p]} ${spendLine((r.cost as Record<Path, Spend>)[p], r.cost?.currency ?? "")}`,
          ),
        ]
      : []),
  ];
  const tally = (name: string, n: Tally) => {
    const part = (s: Score | null) => (s ? `${s.right} right, ${s.stale} stale` : "(they do not fit)");
    return `  ${name}: ${n.questions}; ${PATHS.map((p) => `${NAMES[p]} ${part(n[p])}`).join("; ")}`;
  };
  if (t.stale || r.questions.some((q) => q.kind === "changed")) {
    for (const k of KINDS) if (t.by_kind[k]) lines.push(tally(k.replace("_", " "), t.by_kind[k]));
    for (const [l, n] of Object.entries(t.by_language)) lines.push(tally(`in ${l}`, n as Tally));
  }
  for (const q of r.questions) {
    const mark = q.outcome === q.expected ? (q.outcome === "right" ? "right" : "known gap") : "differs";
    const remarks = [
      ...(q.found === false ? ["not found by search"] : []),
      ...(["mature", "long_context", "governed_long_context"] as const).flatMap((p) => {
        const other = q.baselines[p];
        return other && other.outcome !== q.outcome ? [`${NAMES[p]}: ${other.outcome}`] : [];
      }),
    ];
    const suffix = remarks.length ? ` (${remarks.join("; ")})` : "";
    lines.push(`  ${mark.padEnd(9)} ${q.question}${suffix}`);
    lines.push(`            ${q.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    if (q.cited.length) lines.push(`            cites ${q.cited.join(", ")}`);
    for (const n of q.notes) lines.push(`            ${n}`);
  }
  return lines;
}
