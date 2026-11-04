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
 * A key may also say how its case was built: the fact's `topic`, its `pattern` (how the
 * corpus misleads about it) and its `case` (found in the documents or written for the test).
 * Values the corpus states that never held, from a draft or a summary that drops a condition,
 * are `misleading`: an answer giving one of them without the value in effect is stale too.
 * Values that other governed documents in use state beside the one in effect are
 * `conflicting`: a right answer names every one, and one that names some but not all is
 * `one_sided`. Totals are then also given by topic, pattern and case. A key's `topics` name
 * the spaces each topic is in, and the long contexts read only the question's topic: a model
 * reading every document of a large drive is no rival anyone would run, while search and the
 * mature RAG still look through everything.
 *
 * Each question is also checked for whether the search the answer rests on found an expected
 * text at all (`found`): with stand-ins for the models, a right source the stand-in answer
 * leaves out is the stand-in's miss, a source never found is retrieval's. And each is asked
 * the other ways over the same documents and model (`baselines`): the knowledge base's compact
 * answer, which reads mostly statements and a few passages (Engine.compact); a mature RAG
 * over the same chunks and search, without statements or governance; a model that reads
 * every document, when they fit one context; and the knowledge base reading every document
 * after governance, when they fit. How long each answer took is kept beside it (`latency`): the
 * whole call, the answering model's share and the reranker's.
 *
 * Every path finds the same caches. The search the engine and the mature RAG share runs once
 * for each question before any path answers, so both read its rerank scores and translations
 * from the cache alike; its own time is kept apart (`search_latency`), and a path that
 * searches takes about that much longer in a product. A time whose reply came from the
 * response cache is the cache's, not a model's: it is marked (`cached`), and the medians
 * leave it out.
 *
 * Apart from the answers, an offline audit checks what governance keeps (`retention`, bar 1
 * of docs/design/validation.md): for each question with an answer key, whether what the
 * governed long context gives its model still states the right value, from a document the
 * key cites, and not as a value that no longer holds. It is `kept` when it does, `demoted`
 * when it does but governance holds another value over it (an announced change held back until
 * a person decides), `dropped` when only the raw long context's input states it, and `absent`
 * when neither does. Where governed documents disagree, each of their values
 * must be kept. The audit
 * reads inputs, never answers: an answer that differs over kept evidence is no loss it can
 * see, and a right answer over dropped evidence is still a loss. Both inputs are read as the
 * corpus's reader, so the totals also list any document the governed input cites that the
 * raw one, everything the reader may read, does not (`beyond_raw`). It matches a value and
 * its document only: a sentence that negates the value or narrows it to a condition still
 * counts as kept, and the keys name no conditions yet (issue #68). It calls no model, so the
 * search-only check (searchReport) runs it too, whatever the long-context paths would cost.
 *
 * Like the control check, each question may record where the engine answers it otherwise
 * today and why (`engine`), and the test holds the run to it.
 *
 * What the model calls of each path cost is reported too (`cost`), the shared search's apart,
 * and the latencies' median and 90th percentile (`latency`); sampleQuestions picks a spread
 * of the questions for a quick run.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Citation,
  type GroundedAnswer,
  type SearchHit,
  schemaErrors,
  type UsageRecord,
} from "@inspiration/contracts";
import type { Corpus, Engine } from "@inspiration/engine";
import { languageOf } from "@inspiration/kernel";
import { Gateway } from "@inspiration/model-gateway";
import { ANSWER_TASK, ContextTooLong, type Retrieval, TRANSLATE_TASK } from "@inspiration/retrieval";
import { parse } from "yaml";
import { usageMark } from "./claims.ts";
import { type Spend, spendLine, spendOf, usageSince } from "./cost.ts";

/**
 * How an answer turned out: right, a value no longer in effect, a wrong text, wrong
 * citations, both, or nothing answered.
 */
export type Outcome = "right" | "stale" | "one_sided" | "wrong_answer" | "wrong_citations" | "wrong" | "unanswered";
const OUTCOMES: readonly Outcome[] = [
  "right",
  "stale",
  "one_sided",
  "wrong_answer",
  "wrong_citations",
  "wrong",
  "unanswered",
];

/** What a question asks about: a fact that has had one value, one that has had more, or one not stated. */
export type Kind = "unchanged" | "changed" | "not_stated";
const KINDS: readonly Kind[] = ["unchanged", "changed", "not_stated"];

/**
 * How the corpus misleads about a fact (docs/design/validation.md): an old copy under a path
 * no longer in use, a translation behind its original, a page restating an older value, a
 * newer draft or proposal that does not decide, governed pages that disagree, a change stated
 * only elsewhere, a summary that drops a condition; or not at all, as a control.
 */
export const PATTERNS = [
  "renamed_or_moved",
  "lagging_translation",
  "restated_lagging",
  "newer_not_authoritative",
  "governed_disagree",
  "changed_elsewhere",
  "distorted",
  "control",
] as const;
export type Pattern = (typeof PATTERNS)[number];
/** Whether a case is found in the documents as they are, or built for the test on real text. */
export type Case = "natural" | "constructed";

export interface Question {
  question: string;
  /** Texts one of which a right answer contains; null when nothing in the corpus answers it. */
  answer: string[] | null;
  /** Texts of values no longer in effect: an answer with one of them and none of answer's is stale. */
  stale?: string[];
  /** Documents (corpus paths, a language suffix optional) one of which a right answer cites. */
  cites?: string[];
  /** Further texts a right answer contains one of each: the values other governed documents state. */
  also?: string[][];
  /** The fact of keys.yaml it asks about. */
  fact?: string;
  kind: Kind;
  topic?: string;
  pattern?: Pattern;
  case?: Case;
  /** The spaces of the question's topic, which the long contexts read; every space when absent. */
  spaces?: string[];
  /** Where the engine answers it otherwise today, and why. */
  engine?: { outcome: Outcome; why: string };
}

/** keys.yaml: each fact's values by the day each took effect, and where the corpus states each. */
export interface Keys {
  /** The day the questions are asked: the value in effect then is the answer. */
  asked_on: string;
  /** Each topic's spaces, by their IDs in corpus.yaml. */
  topics?: Record<string, string[]>;
  facts: Record<string, FactKey>;
}

export interface FactKey {
  /** What the fact is, in a few words. */
  about: string;
  topic?: string;
  pattern?: Pattern;
  case?: Case;
  /** In order of the day each took effect. */
  values: KeyValue[];
  /** Values the corpus states that never held, and why each misleads. */
  misleading?: (Stated & { value: string; texts: string[]; why: string })[];
  /** Values other governed documents in use state beside the one in effect. */
  conflicting?: (Stated & { value: string; texts: string[] })[];
}

/** Where the corpus states a value: the file (a corpus path), its revision, and the words, verbatim. */
interface Stated {
  stated: { file: string; revision: string; quote: string }[];
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
const TEXTS = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 };
const STATED = {
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
};

const KEYS_SCHEMA = {
  type: "object",
  required: ["asked_on", "facts"],
  additionalProperties: false,
  properties: {
    asked_on: DAY,
    topics: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    },
    facts: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["about", "values"],
        additionalProperties: false,
        properties: {
          about: { type: "string", minLength: 1 },
          topic: { type: "string", minLength: 1 },
          pattern: { enum: PATTERNS },
          case: { enum: ["natural", "constructed"] },
          values: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["from", "value", "stated"],
              additionalProperties: false,
              properties: { from: DAY, value: { type: ["string", "null"] }, texts: TEXTS, stated: STATED },
            },
          },
          misleading: {
            type: "array",
            items: {
              type: "object",
              required: ["value", "texts", "why", "stated"],
              additionalProperties: false,
              properties: { value: { type: "string" }, texts: TEXTS, why: { type: "string" }, stated: STATED },
            },
          },
          conflicting: {
            type: "array",
            items: {
              type: "object",
              required: ["value", "texts", "stated"],
              additionalProperties: false,
              properties: { value: { type: "string" }, texts: TEXTS, stated: STATED },
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
    if (key.topic !== undefined && !data.topics?.[key.topic]) errors.push(`${fact}: no spaces for topic ${key.topic}`);
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
  const also = answer && key.conflicting?.length ? key.conflicting.map((c) => c.texts) : undefined;
  const said = new Set([...(answer ?? []), ...(also ?? []).flat()]);
  const stale = [
    ...new Set([
      ...key.values.filter((v) => v !== now).flatMap((v) => v.texts ?? []),
      ...(key.misleading ?? []).flatMap((m) => m.texts),
    ]),
  ].filter((t) => !said.has(t));
  const kind: Kind =
    answer === null ? "not_stated" : new Set(key.values.map((v) => v.value)).size > 1 ? "changed" : "unchanged";
  const cites = answer && [
    ...new Set(
      [...(now?.stated ?? []), ...(also ? (key.conflicting ?? []).flatMap((c) => c.stated) : [])].map((s) => s.file),
    ),
  ];
  const spaces = key.topic === undefined ? undefined : keys.topics?.[key.topic];
  return entry.ask.map((a) => {
    const { question, engine } = typeof a === "string" ? { question: a, engine: undefined } : a;
    return {
      question,
      answer,
      ...(stale.length && { stale }),
      ...(cites && { cites }),
      ...(also && { also }),
      fact: entry.fact,
      kind,
      ...(key.topic !== undefined && { topic: key.topic }),
      ...(key.pattern && { pattern: key.pattern }),
      ...(key.case && { case: key.case }),
      ...(spaces && { spaces }),
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
  topic?: string;
  pattern?: Pattern;
  case?: Case;
  language: Language;
  outcome: Outcome;
  /** What the run's outcome should be: the engine entry's, else right. */
  expected: Outcome;
  answer: string;
  /** Whether a source the answer was given states an expected text; null for no answer. */
  found: boolean | null;
  /** How the other ways answer it; a long context is null when the documents do not fit. */
  baselines: { compact: Rival; mature: Rival; long_context: Rival | null; governed_long_context: Rival | null };
  cited: string[];
  notes: string[];
  confidence: number;
  latency: Latency;
  /** The search the engine and the mature RAG share, run once before either answers. */
  search_latency: Latency;
  /** Whether governance kept the right value in what its model reads; null when not audited. */
  retention: Retention | null;
}

/**
 * What the evidence audit found for a question with an answer key, and the documents whose
 * sources state the right value: the governed input's when kept, the raw input's when dropped.
 */
export interface Retention {
  status: "kept" | "demoted" | "dropped" | "absent";
  documents: string[];
}

/** A source a long context gives its model: the text it reads, the documents it cites, and where its value stands. */
export interface InputSource {
  text: string;
  documents: string[];
  standing?: SearchHit["standing"];
  /** The statement's unit, and for a value that does not hold, the unit stating the one that does. */
  unit?: string;
  held?: string;
}

export interface Rival {
  outcome: Outcome;
  answer: string;
  cited: string[];
  latency: Latency;
}

/** How long an answer or a search took, in milliseconds: the whole call, and what its model calls took. */
export interface Latency {
  ms: number;
  /** The answering model's calls; for a search, the translating model's. */
  model_ms: number;
  /** The reranker's calls; a reranker on this machine's CPU is far slower than one on a GPU. */
  rerank_ms: number;
  /**
   * Whether a timed reply came from the response cache, which makes the time the cache's: the
   * answering model's for an answer, the translating model's or the reranker's for a search.
   */
  cached: boolean;
}

/** The ways of answering a question, the engine's first. */
export const PATHS = ["engine", "compact", "mature", "long_context", "governed_long_context"] as const;
export type Path = (typeof PATHS)[number];
/**
 * The paths that read only the question's topic, since a long context must fit the window. The
 * others search everything, as the engine does, so a path added later searches everything too.
 */
const TOPIC_PATHS: ReadonlySet<Path> = new Set(["long_context", "governed_long_context"]);
const NAMES: Record<Path, string> = {
  engine: "engine",
  compact: "engine, compact",
  mature: "mature RAG",
  long_context: "reading everything",
  governed_long_context: "reading everything after governance",
};

/** The median and 90th percentile of a path's latencies, in milliseconds, of the calls no cache answered. */
export interface LatencySummary {
  answers: number;
  /** Answers left out because a timed reply came from the response cache. */
  cached: number;
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
  compact: Score;
  mature: Score;
  long_context: Score | null;
  governed_long_context: Score | null;
}

export interface Score {
  right: number;
  stale: number;
  /** Answers that give some of the values governed documents disagree on, not all; absent when none does. */
  one_sided?: number;
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
    baselines: { compact: number; mature: number; long_context: number | null; governed_long_context: number | null };
    by_kind: Partial<Record<Kind, Tally>>;
    by_language: Partial<Record<Language, Tally>>;
    /** Only for questions whose keys say how their cases were built. */
    by_topic?: Partial<Record<string, Tally>>;
    by_pattern?: Partial<Record<Pattern, Tally>>;
    by_case?: Partial<Record<Case, Tally>>;
    /** Each path's latencies, of the questions it answered, and the shared search's. */
    latency: Partial<Record<Path | "search", LatencySummary>>;
    retention: RetentionTotals;
  };
  /**
   * What each path's model calls cost, in the gateway's currency, and the shared search's,
   * which the engine and the mature RAG would each pay; absent without an in-process gateway.
   */
  cost?: { currency: string } & Record<Path | "search", Spend>;
}

/** The evidence audit's questions by what it found, apart from the answers. */
export interface RetentionTotals {
  kept: number;
  /** Kept, but with another value held over it. */
  demoted: number;
  dropped: number;
  absent: number;
  /** Questions without an answer key, or whose governed input does not fit one context. */
  not_audited: number;
  /** Documents the governed input cites that the raw input does not; null when the raw input does not fit. */
  beyond_raw: string[] | null;
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

/** Whether one of the documents is one the question expects cited; any is when it names none. */
const citesExpected = (q: Question, documents: readonly string[]) =>
  !q.cites?.length || documents.some((p) => q.cites?.some((c) => stem(p) === stem(c) || p === c));

/** How an answer turned out, given the documents its citations are in. */
export function outcomeOf(q: Question, a: GroundedAnswer, cited: readonly string[]): Outcome {
  // Citation markers are not values: on 2026-11-03 "[20]" counted as the expected 20.
  const text = a.answer.replace(/\[\d+\]/g, "");
  // The value in effect, and each value other governed documents state beside it.
  const sides = [says(text, q.answer ?? []), ...(q.also ?? []).map((texts) => says(text, texts))];
  const said = sides.every(Boolean);
  if (!sides.some(Boolean) && says(text, q.stale)) return "stale";
  if (q.answer === null) return a.citations.length === 0 && a.gaps.length > 0 ? "right" : "wrong_answer";
  if (!a.citations.length) return "unanswered";
  if (!said && sides.some(Boolean)) return "one_sided";
  const cites = citesExpected(q, cited);
  if (said && cites) return "right";
  if (said) return "wrong_citations";
  return cites ? "wrong_answer" : "wrong";
}

/**
 * Whether the governed input keeps the right value that the raw one states: the audit reads
 * only what each long context gives its model, never an answer. A source keeps it when it
 * states an expected text, cites an expected document and does not mark the value as one that
 * no longer holds. Where governed documents disagree, every value they state must be kept. The
 * value in effect is demoted when it reaches the model but governance holds another value over
 * it: on 2026-11-03 announced changes were held back that way until a person decided. Null without an answer key, or without a governed input,
 * or when the governed input lacks a value and the raw input does not fit to tell dropped from
 * absent.
 */
export function retentionOf(
  q: Question,
  raw: readonly InputSource[] | null,
  governed: readonly InputSource[] | null,
): Retention | null {
  const expected = q.answer;
  if (!expected || !governed) return null;
  const stating = (sources: readonly InputSource[], texts: readonly string[]) => [
    ...new Set(
      sources
        .filter((s) => s.standing !== "outdated" && says(s.text, texts) && citesExpected(q, s.documents))
        .flatMap((s) => s.documents),
    ),
  ];
  const sides = [expected, ...(q.also ?? [])];
  const kept = sides.map((texts) => stating(governed, texts));
  if (kept.every((documents) => documents.length)) {
    // Demoted: a statement of the value, from a document the key cites, gives way to one that
    // holds another value, and none of its statements holds. A long context holds a whole topic,
    // where another fact may name the same number, and an older edition's statement gives way to
    // its newer edition stating the same value, which is no loss. Governed documents that
    // disagree leave each value disputed until a person decides, as they should.
    const units = new Map(governed.flatMap((s) => (s.unit ? [[s.unit, s] as const] : [])));
    const of = governed.filter(
      (s) => s.standing && q.cites?.length && says(s.text, expected) && citesExpected(q, s.documents),
    );
    const yields = of.some((s) => {
      const held = s.held === undefined ? undefined : units.get(s.held);
      return s.standing !== "holds" && held !== undefined && !says(held.text, expected);
    });
    const demoted = !q.also?.length && yields && !of.some((s) => s.standing === "holds");
    return { status: demoted ? "demoted" : "kept", documents: [...new Set(kept.flat())] };
  }
  if (!raw) return null;
  const dropped = [...new Set(sides.flatMap((texts, i) => (kept[i]?.length ? [] : stating(raw, texts))))];
  return dropped.length ? { status: "dropped", documents: dropped } : { status: "absent", documents: [] };
}

/** The evidence audit's counts over questions, each with its retention, and each topic's inputs. */
function retentionTotals(
  results: readonly { retention: Retention | null }[],
  inputs: readonly { raw: InputSource[] | null; governed: InputSource[] | null }[],
): RetentionTotals {
  return {
    kept: results.filter((r) => r.retention?.status === "kept").length,
    demoted: results.filter((r) => r.retention?.status === "demoted").length,
    dropped: results.filter((r) => r.retention?.status === "dropped").length,
    absent: results.filter((r) => r.retention?.status === "absent").length,
    not_audited: results.filter((r) => !r.retention).length,
    beyond_raw: beyondAll(inputs),
  };
}

/** The documents governed sources cite that no raw source does, in order; null without a raw input. */
export function beyondRaw(
  raw: readonly InputSource[] | null,
  governed: readonly InputSource[] | null,
): string[] | null {
  if (!raw) return null;
  const read = new Set(raw.flatMap((s) => s.documents));
  return [...new Set((governed ?? []).flatMap((s) => s.documents))].filter((d) => !read.has(d));
}

/** beyondRaw over each topic's inputs: every document any of them cites beyond its raw input; null when one does not fit. */
function beyondAll(inputs: readonly { raw: InputSource[] | null; governed: InputSource[] | null }[]): string[] | null {
  const all = new Set<string>();
  for (const { raw, governed } of inputs) {
    const beyond = beyondRaw(raw, governed);
    if (!beyond) return null;
    for (const d of beyond) all.add(d);
  }
  return [...all];
}

/** What the model calls an answer made took, and whether its answering model's reply was cached. */
function answerLatency(used: readonly UsageRecord[]): Omit<Latency, "ms"> {
  const model = (u: UsageRecord) => u.operation === "complete" && u.task === ANSWER_TASK;
  return { ...took(used, model), cached: used.some((u) => model(u) && u.status === "cached") };
}

/** What the model calls a search made took, and whether its translation or rerank scores were cached. */
function searchLatency(used: readonly UsageRecord[]): Omit<Latency, "ms"> {
  const model = (u: UsageRecord) => u.operation === "complete" && u.task === TRANSLATE_TASK;
  const timed = (u: UsageRecord) => model(u) || u.operation === "rerank";
  return { ...took(used, model), cached: used.some((u) => timed(u) && u.status === "cached") };
}

function took(used: readonly UsageRecord[], model: (u: UsageRecord) => boolean) {
  const sum = (keep: (u: UsageRecord) => boolean) => used.filter(keep).reduce((n, u) => n + u.latency_ms, 0);
  return { model_ms: sum(model), rerank_ms: sum((u) => u.operation === "rerank") };
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

function latencyOf(all: readonly Latency[]): LatencySummary {
  const of = all.filter((l) => !l.cached);
  return {
    answers: of.length,
    cached: all.length - of.length,
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

/** The documents citations are in, as corpus paths, each source version looked up once. */
function citationPaths(engine: Engine, corpus: Corpus): (citations: readonly Citation[]) => Promise<string[]> {
  const paths = new Map<string, Promise<string | undefined>>();
  return async (citations) => {
    const of = await Promise.all(
      citations.map((c) => {
        const id = c.source_version_id;
        const path =
          paths.get(id) ??
          engine.store.getSourceVersion(id).then((v) => v && corpus.pathOf(v.source_id, v.external_id));
        paths.set(id, path);
        return path.then((p) => p ?? c.source_title);
      }),
    );
    return [...new Set(of)];
  };
}

type Inputs = { raw: InputSource[] | null; governed: InputSource[] | null };

/**
 * What raw and governed long context give their models, for the evidence audit, by topic; each
 * null when the documents do not fit the context. Every document of a question's topic the reader
 * may read, so the same for each question of it: read once per topic, with no model call.
 */
async function longContextInputs(
  engine: Engine,
  corpus: Corpus,
  questions: readonly Question[],
  pathsOf: (citations: readonly Citation[]) => Promise<string[]>,
): Promise<{ of: (q: Question) => Inputs; all: Inputs[] }> {
  /** What a long context gives its model, of the spaces asked for or all; null when the documents do not fit. */
  const inputOf = async (retrieval: Retrieval, question: string, spaces?: string[]): Promise<InputSource[] | null> => {
    try {
      const hits = await retrieval.sources({ question, ...(spaces && { space_ids: spaces }) }, corpus.reader);
      return await Promise.all(
        hits.map(async (h) => ({
          text: h.snippet,
          documents: await pathsOf(h.citations),
          ...(h.standing && { standing: h.standing, unit: h.unit_id }),
          ...(h.held_unit_id && { held: h.held_unit_id }),
        })),
      );
    } catch (e) {
      if (e instanceof ContextTooLong) return null;
      throw e;
    }
  };
  const topicOf = (q: Question) => q.spaces?.join(" ") ?? "";
  const inputs = new Map<string, Inputs>();
  for (const q of questions) {
    if (inputs.has(topicOf(q))) continue;
    inputs.set(topicOf(q), {
      raw: await inputOf(engine.baselines.long_context, q.question, q.spaces),
      governed: await inputOf(engine.governedLongContext, q.question, q.spaces),
    });
  }
  return { of: (q) => inputs.get(topicOf(q)) as Inputs, all: [...inputs.values()] };
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
  const pathsOf = citationPaths(engine, corpus);
  const inputs = await longContextInputs(engine, corpus, questions, pathsOf);
  const spent = Object.fromEntries([...PATHS, "search"].map((p) => [p, [] as UsageRecord[]])) as Record<
    Path | "search",
    UsageRecord[]
  >;
  /** The call, its usage counted against the path, and how long it and its model calls took. */
  const metered = async <T>(path: Path | "search", call: () => Promise<T>): Promise<{ value: T; latency: Latency }> => {
    const from = usageMark(engine);
    const started = performance.now();
    try {
      const value = await call();
      const ms = Math.round(performance.now() - started);
      const used = usageSince(engine, from);
      return { value, latency: { ms, ...(path === "search" ? searchLatency(used) : answerLatency(used)) } };
    } finally {
      spent[path].push(...usageSince(engine, from));
    }
  };
  for (const q of questions) {
    // First, so that no path pays for the search another path then reads from the cache.
    const searched = await metered("search", () => engine.retrieval.sources({ question: q.question }, corpus.reader));
    const sources = searched.value;
    const own = await metered("engine", () => engine.retrieval.answer({ question: q.question }, corpus.reader));
    const a = own.value;
    const expected = q.answer;
    // The same reading of a text as the answer's, so "5000" in a source is "5,000" found.
    const found = expected && sources.some((h) => says(h.snippet, expected));
    const cited = await pathsOf(a.citations);
    const rival = async (path: Exclude<Path, "engine">, retrieval: Retrieval): Promise<Rival | null> => {
      const spaces = TOPIC_PATHS.has(path) && q.spaces ? { space_ids: q.spaces } : {};
      try {
        const { value: answer, latency } = await metered(path, () =>
          retrieval.answer({ question: q.question, ...spaces }, corpus.reader),
        );
        const cited = await pathsOf(answer.citations);
        return { outcome: outcomeOf(q, answer, cited), answer: answer.answer, cited, latency };
      } catch (e) {
        if (e instanceof ContextTooLong) return null;
        throw e;
      }
    };
    const compact = (await rival("compact", engine.compact)) as Rival;
    const mature = (await rival("mature", engine.baselines.mature)) as Rival;
    const longContext = await rival("long_context", engine.baselines.long_context);
    const governedLongContext = await rival("governed_long_context", engine.governedLongContext);
    const { raw, governed } = inputs.of(q);
    results.push({
      question: q.question,
      ...(q.fact && { fact: q.fact }),
      kind: q.kind,
      ...(q.topic !== undefined && { topic: q.topic }),
      ...(q.pattern && { pattern: q.pattern }),
      ...(q.case && { case: q.case }),
      language: languageOf(q.question),
      outcome: outcomeOf(q, a, cited),
      expected: q.engine?.outcome ?? "right",
      answer: a.answer,
      found: expected ? Boolean(found) : null,
      baselines: { compact, mature, long_context: longContext, governed_long_context: governedLongContext },
      cited,
      notes: (a.notes ?? []).map((n) => `${n.kind}: ${n.text}`),
      confidence: a.confidence,
      latency: own.latency,
      search_latency: searched.latency,
      retention: retentionOf(q, raw, governed),
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
        compact: results.filter((r) => r.baselines.compact.outcome === "right").length,
        mature: results.filter((r) => r.baselines.mature.outcome === "right").length,
        long_context: rightOrNull(results.map((r) => r.baselines.long_context)),
        governed_long_context: rightOrNull(results.map((r) => r.baselines.governed_long_context)),
      },
      by_kind: tallies(results, (r) => r.kind),
      by_language: tallies(results, (r) => r.language),
      ...(results.some((r) => r.pattern) && {
        by_topic: tallies(results, (r) => r.topic ?? "(none)"),
        by_pattern: tallies(results, (r) => r.pattern ?? "control"),
        by_case: tallies(results, (r) => r.case ?? "natural"),
      }),
      latency: Object.fromEntries(
        [...PATHS, "search" as const].flatMap((p) => {
          const of = results.flatMap((r) => {
            const latency = p === "search" ? r.search_latency : p === "engine" ? r.latency : r.baselines[p]?.latency;
            return latency ? [latency] : [];
          });
          return of.length ? [[p, latencyOf(of)]] : [];
        }),
      ),
      retention: retentionTotals(results, inputs.all),
    },
    ...(engine.models instanceof Gateway && {
      cost: {
        currency: engine.models.config.currency,
        ...(Object.fromEntries([...PATHS, "search"].map((p) => [p, spendOf(spent[p as Path | "search"])])) as Record<
          Path | "search",
          Spend
        >),
      },
    }),
  };
}

const tokensOf = (hits: readonly SearchHit[]) => hits.reduce((n, h) => n + h.token_estimate, 0);

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
  /** The compact answer's hits (Engine.compact) as its model is given them. */
  found_compact: boolean | null;
  /** The statements alone among the compact answer's hits: whether the conclusions hold the answer without a passage. */
  found_in_statements: boolean | null;
  /** About how many tokens of sources each answer's model reads: the sum of its hits' estimates. */
  tokens: { engine: number; compact: number; mature: number };
  /** The evidence audit, as the question check runs it (retentionOf): it needs no answer. */
  retention: Retention | null;
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
  found_compact: number;
  found_in_statements: number;
  /** The median tokens of sources each answer's model reads, of every question. */
  median_tokens: { engine: number; compact: number; mature: number };
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
    retention: RetentionTotals;
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
  const inputs = await longContextInputs(engine, corpus, questions, citationPaths(engine, corpus));
  const results: SearchResult[] = [];
  for (const q of questions) {
    const { raw, governed } = inputs.of(q);
    const expected = q.answer;
    // One after another, so the later searches find the first one's rerank scores in the cache
    // instead of a CPU reranker scoring the same passages three times at once.
    const sources = await engine.retrieval.sources({ question: q.question }, corpus.reader);
    const mature = await engine.baselines.mature.sources({ question: q.question }, corpus.reader);
    const compact = await engine.compact.sources({ question: q.question }, corpus.reader);
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
      found_compact: any(compact.map((h) => h.snippet)),
      found_in_statements: any(compact.filter((h) => h.kind !== "chunk").map((h) => h.snippet)),
      tokens: { engine: tokensOf(sources), compact: tokensOf(compact), mature: tokensOf(mature) },
      retention: retentionOf(q, raw, governed),
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
      found_compact: answered.filter((r) => r.found_compact).length,
      found_in_statements: answered.filter((r) => r.found_in_statements).length,
      median_tokens: {
        engine: percentile(
          of.map((r) => r.tokens.engine),
          50,
        ),
        compact: percentile(
          of.map((r) => r.tokens.compact),
          50,
        ),
        mature: percentile(
          of.map((r) => r.tokens.mature),
          50,
        ),
      },
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
    totals: {
      ...tally(results),
      by_kind: by((r) => r.kind),
      by_language: by((r) => r.language),
      retention: retentionTotals(results, inputs.all),
    },
  };
}

function auditLines(t: RetentionTotals): string[] {
  return [
    `  evidence audit, apart from the answers: what governance gives its model keeps the right value for ${t.kept} questions, keeps it marked as not holding for ${t.demoted}, drops one the raw documents state for ${t.dropped}, and neither states it for ${t.absent}; ${t.not_audited} not audited`,
    ...(t.beyond_raw?.length
      ? [
          `  governance cites ${t.beyond_raw.length} documents the raw input does not read, each to check the reader may: ${t.beyond_raw.join(", ")}`,
        ]
      : []),
  ];
}

export function searchLines(r: SearchReport): string[] {
  const depths = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([d, n]) => `${d}: ${n}`)
      .join(", ");
  const line = (name: string, t: SearchTally) => [
    `  ${name}: ${t.questions} with an answer; the engine's answer is given it for ${t.found} (${t.found_whole} with each passage read from the store); the compact answer's for ${t.found_compact} (its statements alone for ${t.found_in_statements}); the mature RAG's for ${t.found_by_mature}`,
    `    sources read, median tokens: engine ${t.median_tokens.engine}, compact ${t.median_tokens.compact}, mature RAG ${t.median_tokens.mature}`,
    `    first hit stating it within ${depths(t.within)}; first document within ${depths(t.within_documents)}`,
  ];
  const lines = ["search only, no answers:", ...line("all", r.totals), ...auditLines(r.totals.retention)];
  for (const [k, t] of Object.entries(r.totals.by_kind)) lines.push(...line(k.replace("_", " "), t as SearchTally));
  for (const [l, t] of Object.entries(r.totals.by_language)) lines.push(...line(`in ${l}`, t as SearchTally));
  for (const q of r.questions) {
    if (q.found === null) continue;
    const mark = q.found ? "given" : q.found_whole ? "in passage" : "missed";
    const where = q.rank === null ? `no hit in the first ${SEARCH_DEPTH}` : `first hit ${q.rank}`;
    const document = q.document_rank === null ? "no document" : `document ${q.document_rank}`;
    const dropped =
      q.retention?.status === "dropped"
        ? `; governance dropped the right value ${q.retention.documents.join(", ")} states`
        : q.retention?.status === "demoted"
          ? "; governance marked the right value as not holding"
          : "";
    lines.push(`  ${mark.padEnd(10)} ${q.question} (${where}, ${document}${dropped})`);
  }
  return lines;
}

function tallies<K extends string>(results: readonly QuestionResult[], keyOf: (r: QuestionResult) => K) {
  const score = (outcomes: (Outcome | undefined)[]): Score => {
    const oneSided = outcomes.filter((o) => o === "one_sided").length;
    return {
      right: outcomes.filter((o) => o === "right").length,
      stale: outcomes.filter((o) => o === "stale").length,
      ...(oneSided && { one_sided: oneSided }),
    };
  };
  const by: Partial<Record<K, Tally>> = {};
  for (const k of [...new Set(results.map(keyOf))].sort()) {
    const of = results.filter((r) => keyOf(r) === k);
    const fit = (path: "long_context" | "governed_long_context") =>
      of.some((r) => r.baselines[path] === null) ? null : score(of.map((r) => r.baselines[path]?.outcome));
    by[k] = {
      questions: of.length,
      engine: score(of.map((r) => r.outcome)),
      compact: score(of.map((r) => r.baselines.compact.outcome)),
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
    `  over the same documents and model, the engine's compact answer answers ${t.baselines.compact} right, a mature RAG ${t.baselines.mature}, a model reading every document ${t.baselines.long_context ?? "(they do not fit)"}, reading every document after governance ${t.baselines.governed_long_context ?? "(they do not fit)"}`,
    ...auditLines(t.retention),
    ...[...PATHS, "search" as const].flatMap((p) => {
      const l = t.latency[p];
      const name = p === "search" ? "the shared search" : NAMES[p];
      const model = p === "search" ? "translating model" : "answering model";
      return l
        ? [
            `  latency of ${name}, ${l.answers} timed, ${l.cached} from the cache left out: median ${l.median_ms} ms, p90 ${l.p90_ms} ms; ${model} median ${l.model_median_ms} ms, p90 ${l.model_p90_ms} ms; reranker median ${l.rerank_median_ms} ms`,
          ]
        : [];
    }),
    ...(r.cost
      ? [
          "  answering cost:",
          ...[...PATHS, "search" as const].map(
            (p) =>
              `    ${p === "search" ? "the shared search, which the engine and the mature RAG each pay" : NAMES[p]} ${spendLine((r.cost as Record<Path | "search", Spend>)[p], r.cost?.currency ?? "")}`,
          ),
        ]
      : []),
  ];
  const tally = (name: string, n: Tally) => {
    const part = (s: Score | null) =>
      s ? `${s.right} right, ${s.stale} stale${s.one_sided ? `, ${s.one_sided} one-sided` : ""}` : "(they do not fit)";
    return `  ${name}: ${n.questions}; ${PATHS.map((p) => `${NAMES[p]} ${part(n[p])}`).join("; ")}`;
  };
  if (t.stale || r.questions.some((q) => q.kind === "changed")) {
    for (const k of KINDS) if (t.by_kind[k]) lines.push(tally(k.replace("_", " "), t.by_kind[k]));
    for (const [l, n] of Object.entries(t.by_language)) lines.push(tally(`in ${l}`, n as Tally));
  }
  for (const [name, by] of [
    ["topic", t.by_topic],
    ["pattern", t.by_pattern],
    ["case", t.by_case],
  ] as const) {
    for (const [k, n] of Object.entries(by ?? {})) lines.push(tally(`${name} ${k.replaceAll("_", " ")}`, n as Tally));
  }
  for (const q of r.questions) {
    const mark = q.outcome === q.expected ? (q.outcome === "right" ? "right" : "known gap") : "differs";
    const remarks = [
      ...(q.found === false ? ["not found by search"] : []),
      ...(q.retention?.status === "dropped"
        ? [`governance dropped the right value ${q.retention.documents.join(", ")} states`]
        : []),
      ...(["compact", "mature", "long_context", "governed_long_context"] as const).flatMap((p) => {
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
