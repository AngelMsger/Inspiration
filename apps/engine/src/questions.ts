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
 * of the two rivals over the same documents and model (`baselines`): plain retrieval over
 * the same chunks, without statements or governance, the way a chunk-only RAG answers; and
 * a model that reads every document, when they fit one context.
 *
 * Like the control check, each question may record where the engine answers it otherwise
 * today and why (`engine`), and the test holds the run to it.
 *
 * What the model calls of each path cost is reported too (`cost`), and sampleQuestions picks
 * a spread of the questions for a quick run.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GroundedAnswer, schemaErrors, type UsageRecord } from "@inspiration/contracts";
import { languageOf } from "@inspiration/kernel";
import { Gateway } from "@inspiration/model-gateway";
import { ContextTooLong, type Retrieval } from "@inspiration/retrieval";
import { parse } from "yaml";
import { usageMark } from "./claims.ts";
import type { Corpus } from "./corpus.ts";
import { type Spend, spendLine, spendOf, usageSince } from "./cost.ts";
import type { Engine } from "./engine.ts";

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
  /** How the rivals answer it; long_context is null when the documents do not fit. */
  baselines: { passages: Rival; long_context: Rival | null };
  cited: string[];
  notes: string[];
  confidence: number;
}

export interface Rival {
  outcome: Outcome;
  answer: string;
  cited: string[];
}

export type Language = ReturnType<typeof languageOf>;

/** Answers right and stale, of the engine and each rival; long_context null when it could not run. */
export interface Tally {
  questions: number;
  engine: Score;
  passages: Score;
  long_context: Score | null;
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
    /** Questions each rival answers right; null when it could not run. */
    baselines: { passages: number; long_context: number | null };
    by_kind: Partial<Record<Kind, Tally>>;
    by_language: Partial<Record<Language, Tally>>;
  };
  /** What each path's model calls cost, in the gateway's currency; absent without an in-process gateway. */
  cost?: { currency: string; engine: Spend; passages: Spend; long_context: Spend };
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
  const spent = { engine: [] as UsageRecord[], passages: [] as UsageRecord[], long_context: [] as UsageRecord[] };
  const metered = async <T>(path: keyof typeof spent, call: () => Promise<T>): Promise<T> => {
    const from = usageMark(engine);
    try {
      return await call();
    } finally {
      spent[path].push(...usageSince(engine, from));
    }
  };
  for (const q of questions) {
    const a = await metered("engine", () => engine.retrieval.answer({ question: q.question }, corpus.reader));
    const sources = await engine.retrieval.sources({ question: q.question }, corpus.reader);
    const expected = q.answer;
    // The same reading of a text as the answer's, so "5000" in a source is "5,000" found.
    const found = expected && sources.some((h) => says(h.snippet, expected));
    const cited = await pathsOf(a);
    const rival = async (path: "passages" | "long_context", retrieval: Retrieval): Promise<Rival | null> => {
      try {
        const answer = await metered(path, () => retrieval.answer({ question: q.question }, corpus.reader));
        const paths = await pathsOf(answer);
        return { outcome: outcomeOf(q, answer, paths), answer: answer.answer, cited: paths };
      } catch (e) {
        if (e instanceof ContextTooLong) return null;
        throw e;
      }
    };
    const passages = (await rival("passages", engine.baselines.passages)) as Rival;
    const longContext = await rival("long_context", engine.baselines.long_context);
    results.push({
      question: q.question,
      ...(q.fact && { fact: q.fact }),
      kind: q.kind,
      language: languageOf(q.question),
      outcome: outcomeOf(q, a, cited),
      expected: q.engine?.outcome ?? "right",
      answer: a.answer,
      found: expected ? Boolean(found) : null,
      baselines: { passages, long_context: longContext },
      cited,
      notes: (a.notes ?? []).map((n) => `${n.kind}: ${n.text}`),
      confidence: a.confidence,
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
        passages: results.filter((r) => r.baselines.passages.outcome === "right").length,
        long_context: results.some((r) => r.baselines.long_context === null)
          ? null
          : results.filter((r) => r.baselines.long_context?.outcome === "right").length,
      },
      by_kind: tallies(results, (r) => r.kind),
      by_language: tallies(results, (r) => r.language),
    },
    ...(engine.models instanceof Gateway && {
      cost: {
        currency: engine.models.config.currency,
        engine: spendOf(spent.engine),
        passages: spendOf(spent.passages),
        long_context: spendOf(spent.long_context),
      },
    }),
  };
}

function tallies<K extends string>(results: readonly QuestionResult[], keyOf: (r: QuestionResult) => K) {
  const score = (outcomes: (Outcome | undefined)[]): Score => ({
    right: outcomes.filter((o) => o === "right").length,
    stale: outcomes.filter((o) => o === "stale").length,
  });
  const by: Partial<Record<K, Tally>> = {};
  for (const k of [...new Set(results.map(keyOf))].sort()) {
    const of = results.filter((r) => keyOf(r) === k);
    by[k] = {
      questions: of.length,
      engine: score(of.map((r) => r.outcome)),
      passages: score(of.map((r) => r.baselines.passages.outcome)),
      long_context: of.some((r) => r.baselines.long_context === null)
        ? null
        : score(of.map((r) => r.baselines.long_context?.outcome)),
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
    `  over the same documents and model, plain retrieval answers ${t.baselines.passages} right, a model reading every document ${t.baselines.long_context ?? "(they do not fit)"}`,
    ...(r.cost
      ? [
          `  answering cost: engine ${spendLine(r.cost.engine, r.cost.currency)}`,
          `    plain retrieval ${spendLine(r.cost.passages, r.cost.currency)}`,
          `    reading everything ${spendLine(r.cost.long_context, r.cost.currency)}`,
        ]
      : []),
  ];
  const tally = (name: string, n: Tally) => {
    const part = (s: Score | null) => (s ? `${s.right} right, ${s.stale} stale` : "(they do not fit)");
    return `  ${name}: ${n.questions}; engine ${part(n.engine)}; plain retrieval ${part(n.passages)}; reading everything ${part(n.long_context)}`;
  };
  if (t.stale || r.questions.some((q) => q.kind === "changed")) {
    for (const k of KINDS) if (t.by_kind[k]) lines.push(tally(k.replace("_", " "), t.by_kind[k]));
    for (const [l, n] of Object.entries(t.by_language)) lines.push(tally(`in ${l}`, n as Tally));
  }
  for (const q of r.questions) {
    const mark = q.outcome === q.expected ? (q.outcome === "right" ? "right" : "known gap") : "differs";
    const remarks = [
      ...(q.found === false ? ["not found by search"] : []),
      ...(q.baselines.passages.outcome !== q.outcome ? [`plain retrieval: ${q.baselines.passages.outcome}`] : []),
      ...(q.baselines.long_context && q.baselines.long_context.outcome !== q.outcome
        ? [`reading everything: ${q.baselines.long_context.outcome}`]
        : []),
    ];
    const suffix = remarks.length ? ` (${remarks.join("; ")})` : "";
    lines.push(`  ${mark.padEnd(9)} ${q.question}${suffix}`);
    lines.push(`            ${q.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    if (q.cited.length) lines.push(`            cites ${q.cited.join(", ")}`);
    for (const n of q.notes) lines.push(`            ${n}`);
  }
  return lines;
}
