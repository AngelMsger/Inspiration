/**
 * The stand-in for a model on extraction.extract_claims, registered as a model_mocks plugin
 * so the fake provider answers extraction prompts the way a model would, deterministically.
 *
 * It reads the window from the prompt and keeps every passage that states something
 * checkable: a number, a normative word ("must", "not more than", "responsible for" ...), a
 * definition, a plan or a decision. Each kept passage becomes one claim quoting the whole
 * span. A table row becomes one claim built from its header and cells. Predicate,
 * qualifiers and value come from the catalogue entries in the prompt: the entry with the
 * longest alias in the text, the qualifier with the longest alias, and the last number
 * before one of the entry's unit words (in a table, the number under a header naming one)
 * or the longest of its enum values. A passage that says when it takes effect ("from 1
 * October 2026") gives its claims valid_from; a change without a day ("postponed to 20
 * November") takes the document's date.
 *
 * The cue words and date patterns of each language come from the packs in languages/, all
 * of them at once. Clauses, and the statements the mock writes itself (from a table row, or
 * a clause that needs its label), follow the document's language, or the language its text
 * looks to be in when the document has no tag.
 *
 * What it does not do, and a model will: rewrite a statement to stand alone (statements are
 * the passage as written), split a passage into several claims, resolve pronouns, or read
 * meaning the catalogue's words do not name. Numbers from the mock measure the pipeline and
 * volumes, not extraction quality.
 */

import type { ChatMessage, ClaimType, ClaimValue } from "@inspiration/contracts";
import { anyOf, type LanguagePack, LanguagePackError, languageOf, loadLanguages } from "@inspiration/kernel";
import type { MockResponder } from "@inspiration/model-gateway";
import { type ExtractedClaim, inputOf, type WindowBlock, type WindowInput } from "./protocol.ts";
import { mentioned, type PredicateEntry } from "./vocabulary.ts";

const PACKS = loadLanguages(new URL("../languages/", import.meta.url).pathname);

/** Any of the packs' words under key, in any case. */
const cue = (key: string) => new RegExp(anyOf(PACKS.flatMap((p) => p.list(key))), "iu");

/** A character class of the packs' marks under key, each a single character. */
function marks(key: string, packs: readonly LanguagePack[] = PACKS): string {
  const all = [...new Set(packs.flatMap((p) => p.list(key)))];
  for (const m of all) if ([...m].length !== 1) throw new LanguagePackError(`${key}: ${m} is not one character`);
  return `[${all.map((m) => m.replace(/[\\\]^-]/g, "\\$&")).join("")}]`;
}

interface DayPattern {
  pattern: RegExp;
  /** Month names in order, for patterns whose month group is a name. */
  months: string[];
}

const days = (key: string, flags = "iu"): DayPattern[] =>
  PACKS.flatMap((p) => p.list(key).map((source) => ({ pattern: new RegExp(source, flags), months: p.list("months") })));

const NORMATIVE = cue("normative");
const DEFINITION = cue("definition");
const PLAN = cue("plan");
const DECISION = cue("decision");
const CHANGE = cue("change");
const NUMBER = /\d/;
/** A number as written, with or without thousands separators: "600", "1,200", "2.5". */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const AMOUNT_ONLY = new RegExp(`^(?:${AMOUNT})$`);
const QUESTION = new RegExp(`${marks("question_marks")}\\s*$`, "u");
const MIN_CHARS = 8;

const SENTENCE_END = new RegExp(`${marks("sentence_ends")}\\s*$`, "u");
const EFFECTIVE = days("effective");
const DAY = days("days");
/** Calendar days, whose numbers are not values; ISO dates are written alike in every language. */
const DATES = [...days("days", "giu").map((d) => d.pattern), /\d{4}-\d{2}-\d{2}/g];

/**
 * How a language splits a passage into clauses, and how it writes a label and its text, the
 * items of a list and the end of a sentence. Unlike cue words, these follow the language of
 * the passage: the ideographic comma separates clauses in Japanese and the items of a list
 * in Chinese.
 */
interface Writing {
  /** The clauses of a passage, each with its mark; a mark between digits ("1,200") separates thousands. */
  clauses: RegExp;
  clauseEnd: RegExp;
  label: string;
  list: string;
  stop: string;
}

function writing(pack: LanguagePack): Writing {
  const mark = marks("clause_marks", [pack]);
  return {
    clauses: new RegExp(`(?:[^${mark.slice(1, -1)}]|(?<=\\d)${mark}(?=\\d))+${mark}?`, "gu"),
    clauseEnd: new RegExp(`${mark}$`, "u"),
    label: pack.text("label_mark"),
    list: pack.text("list_mark"),
    stop: pack.text("full_stop"),
  };
}

const WRITING = new Map(PACKS.map((p) => [p.tag, writing(p)]));

/** The writing of the document's language when it has a tag, else of the language the text looks to be in. */
const writingOf = (text: string, language?: string): Writing =>
  WRITING.get(language?.split("-")[0]?.toLowerCase() ?? "") ??
  WRITING.get(languageOf(text)) ??
  (WRITING.get("en") as Writing);

/** The leftmost day any of the patterns finds, as numbers written in digits. */
function firstDay(
  patterns: readonly DayPattern[],
  text: string,
): { year?: string; month: string; day: string } | undefined {
  let found: { index: number; year?: string; month: string; day: string } | undefined;
  for (const { pattern, months } of patterns) {
    const m = pattern.exec(text);
    const g = m?.groups;
    if (!m || !g?.month || !g.day || (found && found.index <= m.index)) continue;
    const month = /^\d+$/.test(g.month) ? g.month : String(months.indexOf(g.month.toLowerCase()) + 1);
    found = { index: m.index, month, day: g.day, ...(g.year && { year: g.year }) };
  }
  return found;
}

const isoDay = (year: string, month: string, day: string) =>
  `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

/** The day a passage says it takes effect, as YYYY-MM-DD. */
export function effectiveFrom(text: string): string | undefined {
  const d = firstDay(EFFECTIVE, text);
  return d?.year ? isoDay(d.year, d.month, d.day) : undefined;
}

/** The day a plan names ("to be finished by 20 November 2026"), in the document's year when it gives none. */
export function plannedFor(text: string, documentDate?: string): string | undefined {
  const d = firstDay(DAY, text);
  const year = d?.year ?? documentDate?.slice(0, 4);
  return d && year ? isoDay(year, d.month, d.day) : undefined;
}

function claimType(text: string, fitted: boolean): ClaimType | undefined {
  if (QUESTION.test(text) || [...text].length < MIN_CHARS) return undefined;
  if (DEFINITION.test(text)) return "definition";
  if (PLAN.test(text)) return "plan";
  // A catalogue word alone makes a claim of a sentence, not of a title.
  if (NORMATIVE.test(text) || DECISION.test(text) || (fitted && SENTENCE_END.test(text))) return "rule";
  if (NUMBER.test(text)) return "fact";
  return undefined;
}

const longest = (words: readonly string[], text: string) =>
  mentioned(text, words).reduce((a, w) => (w.length > a.length ? w : a), "");

interface Fit {
  entry: PredicateEntry;
  qualifier?: string;
}

/** The entry with the longest alias in the text, else in the context; the qualifier comes from the text only. */
function fit(text: string, vocabulary: readonly PredicateEntry[], context = ""): Fit | undefined {
  const best = (within: string) => {
    let found: PredicateEntry | undefined;
    let length = 0;
    for (const entry of vocabulary) {
      const n = longest(entry.aliases, within).length;
      if (n > length) [found, length] = [entry, n];
    }
    return found;
  };
  const entry = best(text) ?? (context ? best(context) : undefined);
  if (!entry) return undefined;
  let qualifier: string | undefined;
  let length = 0;
  for (const q of entry.qualifiers ?? []) {
    const n = longest(q.aliases, text).length;
    if (n > length) [qualifier, length] = [q.name, n];
  }
  return qualifier ? { entry, qualifier } : { entry };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function readValue(text: string, entry: PredicateEntry): ClaimValue | undefined {
  const v = entry.value;
  if (v.kind === "enum" || v.kind === "text" || v.kind === "boolean") {
    const found = longest(v.values ?? [], text);
    return found ? { kind: v.kind === "boolean" ? "enum" : v.kind, text: found, normalized: found } : undefined;
  }
  const words = v.words ?? [];
  const pattern = words.length ? `(${AMOUNT})\\s*(?:${words.map(escapeRegExp).join("|")})` : `(${AMOUNT})`;
  // The last number wins: conditions come first ("after 1 year of service, 5 days of leave").
  const undated = DATES.reduce((t, d) => t.replace(d, " "), text);
  const match = [...undated.matchAll(new RegExp(pattern, "gi"))].at(-1);
  if (!match?.[1]) return undefined;
  const number = Number(match[1].replaceAll(",", ""));
  return {
    kind: v.kind,
    number,
    ...(v.unit && { unit: v.unit }),
    ...(v.currency && { currency: v.currency }),
    normalized: v.unit ? `${number} ${v.unit}` : String(number),
  };
}

function claimOf(
  statement: string,
  evidence: ExtractedClaim["evidence"],
  fitted: Fit | undefined,
  value: ClaimValue | undefined,
  block: WindowBlock,
  input: WindowInput,
  validFrom?: string,
): ExtractedClaim | undefined {
  const type = claimType(statement, fitted !== undefined);
  if (!type) return undefined;
  const claim: ExtractedClaim = {
    statement,
    claim_type: type,
    knowledge_class: fitted?.entry.knowledge_class ?? (type === "rule" ? "policy" : "general"),
    subject: block.heading_path.at(-1) ?? input.document.title,
    confidence: fitted ? 0.9 : 0.7,
    evidence,
  };
  if (validFrom) claim.valid_from = validFrom;
  if (fitted) {
    claim.predicate = fitted.entry.predicate;
    if (fitted.qualifier) claim.qualifiers = [fitted.qualifier];
    if (value) claim.value = value;
  }
  return claim;
}

function rowClaim(block: WindowBlock, input: WindowInput): ExtractedClaim | undefined {
  const cells = block.spans.map((s, i) => ({ ...s, text: s.text.trim(), header: block.header?.[i] ?? "" }));
  if (!cells.some((c) => NUMBER.test(c.text))) return undefined;
  const w = writingOf(cells.map((c) => `${c.header}${c.text}`).join(""), input.document.language);
  const text = cells.map((c) => (c.header ? `${c.header}${w.label}${c.text}` : c.text)).join(w.list);
  const evidence = cells.filter((c) => c.text).map((c) => ({ span: c.ref, quote: c.text }));
  // Rows rarely name their subject; the heading or the file does ("hotel rates by city.csv"),
  // when a header carries the entry's unit ("cap per night (yuan)").
  let fitted = fit(text, input.vocabulary);
  if (!fitted) {
    const guess = fit(text, input.vocabulary, [...block.heading_path, input.document.title].join("\n"));
    const words = guess?.entry.value.words ?? [];
    if (cells.some((c) => mentioned(c.header, words).length)) fitted = guess;
  }
  let value: ClaimValue | undefined;
  if (fitted) {
    // A table names its unit in the header: "cap per night (yuan)" over "600".
    const words = fitted.entry.value.words ?? [];
    const cell = cells.find((c) => AMOUNT_ONLY.test(c.text) && mentioned(c.header, words).length);
    const word = cell && mentioned(cell.header, words)[0];
    value = cell && word ? readValue(`${cell.text}${word}`, fitted.entry) : readValue(text, fitted.entry);
  }
  // A table row is a statement, whatever punctuation it lacks.
  return claimOf(`${text}${w.stop}`, evidence, fitted, value, block, input);
}

/**
 * One claim per passage, unless the passage gives a catalogue value in more than one
 * clause ("650 yuan a night in tier-1 cities, 450 yuan in new tier-1 cities"): then one claim
 * per such clause.
 */
function passageClaims(ref: string, text: string, block: WindowBlock, input: WindowInput): ExtractedClaim[] {
  const whole = fit(text, input.vocabulary);
  const validFrom =
    effectiveFrom(text) ??
    (CHANGE.test(text) ? input.document.date : undefined) ??
    (PLAN.test(text) ? plannedFor(text, input.document.date) : undefined);
  const w = writingOf(text, input.document.language);
  const clauses = (text.match(w.clauses) ?? []).map((c) => c.trim()).filter(Boolean);
  if (whole && clauses.length > 1) {
    const valued = clauses.flatMap((clause) => {
      const fitted = fit(clause, input.vocabulary, text) as Fit;
      const value = readValue(clause, fitted.entry);
      const named = mentioned(clause, fitted.entry.aliases).length > 0;
      return value ? [{ clause, fitted, value, named }] : [];
    });
    if (valued.length > 1) {
      return valued.flatMap(({ clause, fitted, value, named }) => {
        const quote = clause.replace(w.clauseEnd, "");
        const said = named ? quote : `${fitted.entry.label}${w.label}${quote}`;
        // The last clause keeps the passage's own full stop.
        const statement = SENTENCE_END.test(said) ? said : `${said}${w.stop}`;
        return claimOf(statement, [{ span: ref, quote }], fitted, value, block, input, validFrom) ?? [];
      });
    }
  }
  const value = whole && readValue(text, whole.entry);
  const claim = claimOf(text, [{ span: ref, quote: text }], whole, value, block, input, validFrom);
  return claim ? [claim] : [];
}

export function extractWindow(input: WindowInput): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const block of input.blocks) {
    if (block.kind === "table_row") {
      const claim = block.header ? rowClaim(block, input) : undefined;
      if (claim) claims.push(claim);
      continue;
    }
    for (const span of block.spans) claims.push(...passageClaims(span.ref, span.text.trim(), block, input));
  }
  return claims;
}

export const mockExtractClaims: MockResponder = (messages: readonly ChatMessage[]) => {
  const input = inputOf(messages.map((m) => m.content).join("\n"));
  return JSON.stringify({ claims: input ? extractWindow(input) : [] });
};
