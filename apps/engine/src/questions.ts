/**
 * The question check: questions.yaml beside a corpus asks questions in any language, as the
 * corpus's reader, and says what a right answer contains and which documents it cites. Each
 * answer is right when it contains one of the expected texts, and cited right when one of
 * its citations is in one of the expected documents (a path without its language suffix
 * matches every translation: "docs/a" matches docs/a.html and docs/a.ja.html). A question
 * with `answer: null` has no answer in the corpus: it is right when nothing is cited and
 * the question comes back as a gap.
 *
 * Each question is also checked for whether the search the answer rests on found an expected
 * text at all (`found`): with stand-ins for the models, a right source the stand-in answer
 * leaves out is the stand-in's miss, a source never found is retrieval's.
 *
 * Like the control check, each question may record where the engine answers it otherwise
 * today and why (`engine`), and the test holds the run to it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GroundedAnswer, schemaErrors } from "@inspiration/contracts";
import { ANSWER_SOURCES } from "@inspiration/retrieval";
import { parse } from "yaml";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";

/** How an answer turned out: right, a wrong text, wrong citations, both, or nothing answered. */
export type Outcome = "right" | "wrong_answer" | "wrong_citations" | "wrong" | "unanswered";

export interface Question {
  question: string;
  /** Texts one of which a right answer contains; null when nothing in the corpus answers it. */
  answer: string[] | null;
  /** Documents (corpus paths, a language suffix optional) one of which a right answer cites. */
  cites?: string[];
  /** Where the engine answers it otherwise today, and why. */
  engine?: { outcome: Outcome; why: string };
}

export class QuestionsError extends Error {
  override name = "QuestionsError";
}

const SCHEMA = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["question", "answer"],
        additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 1 },
          answer: { anyOf: [{ type: "null" }, { type: "array", items: { type: "string" }, minItems: 1 }] },
          cites: { type: "array", items: { type: "string" } },
          engine: {
            type: "object",
            required: ["outcome", "why"],
            additionalProperties: false,
            properties: {
              outcome: { enum: ["right", "wrong_answer", "wrong_citations", "wrong", "unanswered"] },
              why: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export async function loadQuestions(dir: string): Promise<Question[] | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "questions.yaml"), "utf8");
  } catch {
    return undefined;
  }
  const data = parse(text) as { questions: Question[] };
  const errors = schemaErrors(SCHEMA, data);
  if (errors.length) throw new QuestionsError(`questions.yaml: ${errors.join("; ")}`);
  return data.questions;
}

export interface QuestionResult {
  question: string;
  outcome: Outcome;
  /** What the run's outcome should be: the engine entry's, else right. */
  expected: Outcome;
  answer: string;
  /** Whether a source the answer was given states an expected text; null for no answer. */
  found: boolean | null;
  cited: string[];
  notes: string[];
  confidence: number;
}

export interface QuestionsReport {
  questions: QuestionResult[];
  totals: {
    questions: number;
    right: number;
    as_recorded: number;
    cited_right: number;
    /** Questions with an answer whose search found an expected text. */
    found: number;
    notes: number;
  };
}

/** The path without its language suffix and extension: docs/a.zh-cn.html is docs/a. */
const stem = (path: string) => path.replace(/(\.[a-z]{2}(-[a-z]{2,4})?)?\.[a-z0-9]+$/i, "");

function outcomeOf(q: Question, a: GroundedAnswer, cited: readonly string[]): Outcome {
  if (q.answer === null) return a.citations.length === 0 && a.gaps.length > 0 ? "right" : "wrong_answer";
  if (!a.citations.length) return "unanswered";
  const said = q.answer.some((t) => a.answer.includes(t));
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
  for (const q of questions) {
    const a = await engine.retrieval.answer({ question: q.question }, corpus.reader);
    const sources = await engine.retrieval.search({ text: q.question, top_k: ANSWER_SOURCES }, corpus.reader);
    const expected = q.answer;
    const found = expected && sources.hits.some((h) => expected.some((t) => h.snippet.includes(t)));
    const versions = await Promise.all(
      [...new Set(a.citations.map((c) => c.source_version_id))].map((id) => engine.store.getSourceVersion(id)),
    );
    const pathOf = new Map(
      versions.flatMap((v) => (v ? [[v.id, corpus.pathOf(v.source_id, v.external_id)] as const] : [])),
    );
    const cited = [...new Set(a.citations.map((c) => pathOf.get(c.source_version_id) ?? c.source_title))];
    const outcome = outcomeOf(q, a, cited);
    results.push({
      question: q.question,
      outcome,
      expected: q.engine?.outcome ?? "right",
      answer: a.answer,
      found: expected ? Boolean(found) : null,
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
      as_recorded: results.filter((r) => r.outcome === r.expected).length,
      cited_right: results.filter((r) => r.outcome === "right" || r.outcome === "wrong_answer").length,
      found: results.filter((r) => r.found).length,
      notes: results.reduce((n, r) => n + r.notes.length, 0),
    },
  };
}

export function questionLines(r: QuestionsReport): string[] {
  const t = r.totals;
  const answerable = r.questions.filter((q) => q.found !== null).length;
  const lines = [
    `questions: ${t.questions}, ${t.right} answered right, ${t.as_recorded - t.right} otherwise as recorded, ${t.questions - t.as_recorded} otherwise`,
    `  search found an expected text for ${t.found} of ${answerable} questions with an answer`,
  ];
  for (const q of r.questions) {
    const mark = q.outcome === q.expected ? (q.outcome === "right" ? "right" : "known gap") : "differs";
    const where = q.found === false ? " (not found by search)" : "";
    lines.push(`  ${mark.padEnd(9)} ${q.question}${where}`);
    lines.push(`            ${q.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    if (q.cited.length) lines.push(`            cites ${q.cited.join(", ")}`);
    for (const n of q.notes) lines.push(`            ${n}`);
  }
  return lines;
}
