/**
 * The evidence audit (`retention`, bar 1 of docs/design/validation.md): for each question with
 * an answer key, whether what the governed long context gives its model still states the right
 * value, from a document the key cites, with the meaning the key gives it, and not as a value
 * that no longer holds. It is `kept` when it does, `demoted` when it does but governance holds
 * another value over it (an announced change held back until a person decides),
 * `changed_meaning` when it states the value only denied, narrowed or without the condition
 * the key names, `dropped` when only the raw long context's input states it, and `absent` when
 * neither does. Where governed documents disagree, each of their values must be kept. The
 * audit reads inputs, never answers: an answer that differs over kept evidence is no loss it
 * can see, and a right answer over dropped evidence is still a loss. Both inputs are read as
 * the corpus's reader, so the totals also list any document the governed input cites that the
 * raw one, everything the reader may read, does not (`beyond_raw`). It calls no model, so the
 * search-only check (searchReport) runs it too, whatever the long-context paths would cost.
 *
 * Stating a value is not keeping it: "Meals are not covered up to $120 a day" and "$120 a day,
 * only for executives" both state 120. So a source keeps a value only when a clause that states
 * it denies it exactly when the key's own quotes do and narrows it exactly when they do, or,
 * where the key names who or what the value holds for (`condition`), names that condition in
 * the same clause. A source that holds one of the key's quotes keeps the meaning the key reads
 * there unless the words before the quote, in its clause, deny or narrow it; what runs on after
 * the quote is not read. A question written with its answer texts alone, and no key, names no
 * meaning, so its sources are held to the value and its document only.
 *
 * It is a lexical check, not an understanding: the words that deny or narrow a value are data,
 * in the `audit` section of languages/<tag>.yaml, and a denial or a narrowing those words miss
 * passes, as does a further narrowing of the key's condition ("only for executives in Paris").
 * Documents carry no language tag, so every text is read with all the packs at once; phrases
 * that bound or widen a value rather than deny it ("no more than", "regardless") and the value's
 * own words ("no set limit") are taken out before negations are looked for.
 */

import type { SearchHit } from "@inspiration/contracts";
import { anyOf, loadLanguages } from "@inspiration/kernel";
import type { Question } from "./questions.ts";

/**
 * What the evidence audit found for a question with an answer key, and the documents whose
 * sources state the right value: the governed input's when kept or stated with another
 * meaning, the raw input's when dropped.
 */
export interface Retention {
  status: "kept" | "demoted" | "changed_meaning" | "dropped" | "absent";
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

/** The evidence audit's questions by what it found, apart from the answers. */
export interface RetentionTotals {
  kept: number;
  /** Kept, but with another value held over it. */
  demoted: number;
  /** Stated only denied, narrowed or without the key's condition. */
  changed_meaning: number;
  dropped: number;
  absent: number;
  /** Questions without an answer key, or whose governed input does not fit one context. */
  not_audited: number;
  /** Documents the governed input cites that the raw input does not; null when the raw input does not fit. */
  beyond_raw: string[] | null;
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
export const citesExpected = (q: Question, documents: readonly string[]) =>
  !q.cites?.length || documents.some((p) => q.cites?.some((c) => stem(p) === stem(c) || p === c));

const PACKS = loadLanguages(new URL("../languages/", import.meta.url)).flatMap((p) =>
  p.has("audit") ? [p.section("audit")] : [],
);
const cues = (key: string, flags: string) => new RegExp(anyOf(PACKS.flatMap((p) => p.list(key))), flags);
const CLAUSE_END = cues("clause_ends", "u");
const CLAUSE_ENDS = cues("clause_ends", "gu");
const NEGATION = cues("negations", "iu");
const NOT_NEGATION = cues("not_negations", "giu");
const RESTRICTION = cues("restrictions", "iu");

interface Meaning {
  negated: boolean;
  restricted: boolean;
}

/** Whether words of a clause, without the value's own, deny it and whether they narrow it. */
function cuesOf(clause: string, texts: readonly string[]): Meaning {
  let rest = plain(clause).replaceAll("\u2019", "'");
  for (const t of texts) rest = rest.replaceAll(plain(t), " ");
  rest = rest.replace(NOT_NEGATION, " ");
  return { negated: NEGATION.test(rest), restricted: RESTRICTION.test(rest) };
}

/** The clauses of the text that state the value; the whole text when no clause states it alone. */
function clausesOf(text: string, texts: readonly string[]): string[] {
  const clauses = text.split(CLAUSE_END).filter((c) => says(c, texts));
  return clauses.length ? clauses : [text];
}

/**
 * Whether the text holds one of the quotes with nothing before it in its clause that denies or
 * narrows it, beyond what the key's condition allows: the key read the value's meaning in those
 * words, and what runs on after them, as a list joined into one line runs into the sentence
 * after it, is not part of it.
 */
function holdsQuote(text: string, texts: readonly string[], quotes: readonly string[], condition?: readonly string[]) {
  const hay = plain(text);
  return quotes.some((quote) => {
    const at = hay.indexOf(plain(quote));
    if (at < 0) return false;
    const before = hay.slice(0, at);
    const start = Math.max(0, ...[...before.matchAll(CLAUSE_ENDS)].map((m) => m.index + m[0].length));
    const lead = cuesOf(before.slice(start), texts);
    if (lead.negated) return false;
    return condition ? says(before.slice(start) + plain(quote), condition) : !lead.restricted;
  });
}

/**
 * Whether the text states the value with the key's meaning, as far as words can tell it: in a
 * clause that denies it exactly when one of the key's quotes does, and narrows it exactly when
 * that quote does, or, where the key names its condition, a clause that names it. A source that
 * holds a quote keeps it unless the words before the quote deny or narrow it.
 */
export function keepsMeaning(
  text: string,
  texts: readonly string[],
  quotes: readonly string[] = [],
  condition?: readonly string[],
): boolean {
  if (holdsQuote(text, texts, quotes, condition)) return true;
  const key = quotes.length
    ? quotes.flatMap((quote) => clausesOf(quote, texts).map((c) => cuesOf(c, texts)))
    : [{ negated: false, restricted: false }];
  return clausesOf(text, texts).some((clause) => {
    if (condition && !says(clause, condition)) return false;
    const m = cuesOf(clause, texts);
    return key.some((k) => k.negated === m.negated && (condition !== undefined || k.restricted === m.restricted));
  });
}

/**
 * Whether the governed input keeps the right value that the raw one states: the audit reads
 * only what each long context gives its model, never an answer. A source keeps it when it
 * states an expected text with the key's meaning (keepsMeaning), cites an expected document
 * and does not mark the value as one that no longer holds. Where governed documents disagree,
 * every value they state must be kept. The value in effect is demoted when it reaches the
 * model but governance holds another value over it: on 2026-11-03 announced changes were held
 * back that way until a person decided. Null without an answer key, or without a governed
 * input, or when the governed input lacks a value and the raw input does not fit to tell
 * dropped from absent.
 */
export function retentionOf(
  q: Question,
  raw: readonly InputSource[] | null,
  governed: readonly InputSource[] | null,
): Retention | null {
  const expected = q.answer;
  if (!expected || !governed) return null;
  const sides = [expected, ...(q.also ?? [])];
  const stating = (sources: readonly InputSource[], side: number, meant = true) => {
    const texts = sides[side] as string[];
    const condition = side === 0 ? q.condition : undefined;
    return [
      ...new Set(
        sources
          .filter(
            (s) =>
              s.standing !== "outdated" &&
              says(s.text, texts) &&
              citesExpected(q, s.documents) &&
              (!meant || !q.quotes || keepsMeaning(s.text, texts, q.quotes[side], condition)),
          )
          .flatMap((s) => s.documents),
      ),
    ];
  };
  const kept = sides.map((_, i) => stating(governed, i));
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
  const changed = sides.map((_, i) => (kept[i]?.length ? [] : stating(governed, i, false)));
  if (sides.every((_, i) => kept[i]?.length || changed[i]?.length)) {
    return { status: "changed_meaning", documents: [...new Set(changed.flat())] };
  }
  if (!raw) return null;
  const lost = (i: number) => !kept[i]?.length && !changed[i]?.length;
  const dropped = [...new Set(sides.flatMap((_, i) => (lost(i) ? stating(raw, i) : [])))];
  return dropped.length ? { status: "dropped", documents: dropped } : { status: "absent", documents: [] };
}

/** The evidence audit's counts over questions, each with its retention, and each topic's inputs. */
export function retentionTotals(
  results: readonly { retention: Retention | null }[],
  inputs: readonly { raw: InputSource[] | null; governed: InputSource[] | null }[],
): RetentionTotals {
  const count = (status: Retention["status"]) => results.filter((r) => r.retention?.status === status).length;
  return {
    kept: count("kept"),
    demoted: count("demoted"),
    changed_meaning: count("changed_meaning"),
    dropped: count("dropped"),
    absent: count("absent"),
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

/** The audit's lines in a report. */
export function auditLines(t: RetentionTotals): string[] {
  return [
    `  evidence audit, apart from the answers: what governance gives its model keeps the right value for ${t.kept} questions, keeps it marked as not holding for ${t.demoted}, states it only denied, narrowed or without its condition for ${t.changed_meaning}, drops one the raw documents state for ${t.dropped}, and neither states it for ${t.absent}; ${t.not_audited} not audited`,
    ...(t.beyond_raw?.length
      ? [
          `  governance cites ${t.beyond_raw.length} documents the raw input does not read, each to check the reader may: ${t.beyond_raw.join(", ")}`,
        ]
      : []),
  ];
}

/** What a question's line in a report says about a loss the audit found; empty when there is none. */
export function auditRemark(r: Retention | null): string {
  if (r?.status === "dropped") return `governance dropped the right value ${r.documents.join(", ")} states`;
  if (r?.status === "demoted") return "governance marked the right value as not holding";
  if (r?.status === "changed_meaning") {
    return `governance states the right value only denied, narrowed or without its condition (${r.documents.join(", ")})`;
  }
  return "";
}
