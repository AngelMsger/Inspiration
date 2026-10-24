/**
 * The stand-in for a model on extraction.extract_claims, registered as a model_mocks plugin
 * so the fake provider answers extraction prompts the way a model would, deterministically.
 *
 * It reads the window from the prompt and keeps every passage that states something
 * checkable: a number, a normative word (须, 不得, 不超过, 负责 ...), a definition, a plan
 * or a decision. Each kept passage becomes one claim quoting the whole span. A table row
 * becomes one claim built from its header and cells. Predicate, qualifiers and value come
 * from the catalogue entries in the prompt: the entry with the longest alias in the text,
 * the qualifier with the longest alias, and the last number before one of the entry's
 * unit words (in a table, the number under a header naming one) or the longest of its enum
 * values. A passage that says when it takes effect ("自 2026 年 10 月 1 日起") gives its
 * claims valid_from; a change without a day ("推迟至 11 月 20 日") takes the document's date.
 *
 * What it does not do, and a model will: rewrite a statement to stand alone (statements are
 * the passage as written), split a passage into several claims, resolve pronouns, or read
 * meaning the catalogue's words do not name. Numbers from the mock measure the pipeline and
 * volumes, not extraction quality.
 */

import type { ChatMessage, ClaimType, ClaimValue } from "@inspiration/contracts";
import type { MockResponder } from "@inspiration/model-gateway";
import { type ExtractedClaim, inputOf, type WindowBlock, type WindowInput } from "./protocol.ts";
import type { PredicateEntry } from "./vocabulary.ts";

const NORMATIVE =
  /须|必须|应当|应在|应于|应经|不得|禁止|严禁|不超过|不低于|不少于|至少|最多|上限|限额|负责|审批|批准|方可|一律|原则上|要求/;
const DEFINITION = /是指|指的是|定义为|系指/;
const PLAN = /计划|将于|预计|拟于|下一步/;
const DECISION = /决定|会议确定|会议同意|一致同意/;
const NUMBER = /\d/;
const QUESTION = /[？?]\s*$/;
const MIN_CHARS = 8;

const SENTENCE_END = /[。；;！!]\s*$/;
const EFFECTIVE = /自\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*起|(\d{4})-(\d{2})-(\d{2})\s*起/;

const CHANGE = /调整为|调整至|推迟至|提前至|延长至|缩短至|改为|变更为/;

/** The day a passage says it takes effect, as YYYY-MM-DD. */
export function effectiveFrom(text: string): string | undefined {
  const m = EFFECTIVE.exec(text);
  if (!m) return undefined;
  const [year, month, day] = (m[1] ? m.slice(1, 4) : m.slice(4, 7)) as [string, string, string];
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
const CLAUSES = /[^，；,;]+[，；,;]?/g;

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
  words.filter((w) => text.includes(w)).reduce((a, w) => (w.length > a.length ? w : a), "");

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

/** Calendar days ("2026 年 10 月 1 日", "11 月 20 日", "2026-10-01"), whose numbers are not values. */
const DATES = /(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}/g;

export function readValue(text: string, entry: PredicateEntry): ClaimValue | undefined {
  const v = entry.value;
  if (v.kind === "enum" || v.kind === "text" || v.kind === "boolean") {
    const found = longest(v.values ?? [], text);
    return found ? { kind: v.kind === "boolean" ? "enum" : v.kind, text: found, normalized: found } : undefined;
  }
  const words = v.words ?? [];
  const pattern = words.length
    ? `(\\d+(?:\\.\\d+)?)\\s*(?:${words.map(escapeRegExp).join("|")})`
    : "(\\d+(?:\\.\\d+)?)";
  // The last number wins: conditions come first in Chinese ("满 1 年……年休假 5 天").
  const match = [...text.replace(DATES, " ").matchAll(new RegExp(pattern, "g"))].at(-1);
  if (!match?.[1]) return undefined;
  const number = Number(match[1]);
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
  const text = cells.map((c) => (c.header ? `${c.header}：${c.text}` : c.text)).join("，");
  const evidence = cells.filter((c) => c.text).map((c) => ({ span: c.ref, quote: c.text }));
  // Rows rarely name their subject; the heading or the file does ("城市住宿标准.csv"), when a
  // header carries the entry's unit ("每晚限额（元）").
  let fitted = fit(text, input.vocabulary);
  if (!fitted) {
    const guess = fit(text, input.vocabulary, [...block.heading_path, input.document.title].join("\n"));
    const words = guess?.entry.value.words ?? [];
    if (cells.some((c) => words.some((w) => c.header.includes(w)))) fitted = guess;
  }
  let value: ClaimValue | undefined;
  if (fitted) {
    // A table names its unit in the header: "每晚限额（元）" over "600".
    const words = fitted.entry.value.words ?? [];
    const cell = cells.find((c) => /^\d+(?:\.\d+)?$/.test(c.text) && words.some((w) => c.header.includes(w)));
    const word = cell && words.find((w) => cell.header.includes(w));
    value = cell && word ? readValue(`${cell.text}${word}`, fitted.entry) : readValue(text, fitted.entry);
  }
  // A table row is a statement, whatever punctuation it lacks.
  return claimOf(`${text}。`, evidence, fitted, value, block, input);
}

/**
 * One claim per passage, unless the passage gives a catalogue value in more than one
 * clause ("一线城市每晚 650 元，新一线城市 450 元"): then one claim per such clause.
 */
function passageClaims(ref: string, text: string, block: WindowBlock, input: WindowInput): ExtractedClaim[] {
  const whole = fit(text, input.vocabulary);
  const validFrom = effectiveFrom(text) ?? (CHANGE.test(text) ? input.document.date : undefined);
  const clauses = (text.match(CLAUSES) ?? []).map((c) => c.trim()).filter(Boolean);
  if (whole && clauses.length > 1) {
    const valued = clauses.flatMap((clause) => {
      const fitted = fit(clause, input.vocabulary, text) as Fit;
      const value = readValue(clause, fitted.entry);
      const named = fitted.entry.aliases.some((a) => clause.includes(a));
      return value ? [{ clause, fitted, value, named }] : [];
    });
    if (valued.length > 1) {
      return valued.flatMap(({ clause, fitted, value, named }) => {
        const quote = clause.replace(/[，；,;]$/, "");
        const statement = named ? `${quote}。` : `${fitted.entry.label}：${quote}。`;
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
