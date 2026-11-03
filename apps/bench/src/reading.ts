/**
 * The reading check: whether extraction finds the facts keys.yaml keys, where the key says the
 * corpus states them. Each place a key gives a value (a file, with the value it states there)
 * is `found` when governance holds a statement of that value in the fact's slot from that
 * file, `misread` when the file is in the slot with other values only, and `missed` when the
 * file is not in the slot at all. A value a file puts in a keyed slot that no key gives that
 * file is an `extra`: a value read wrong, or a statement the key overlooks, which reading the
 * quote tells apart. Slots no key names are not judged, and a fact the corpus's catalogue
 * has no entry for is `uncatalogued`: extraction cannot put it in a slot, and only answers
 * find it.
 *
 * A key says each value as its document does ("more than 3 days", "stable since v1.25");
 * extraction writes it the one way the fact's catalogue entry does ("3 day", "stable"), so the
 * check compares the key's value in that form (keyedForm).
 *
 * It reads governance's value groups after an ingest and calls no model, so the run that
 * answers the questions also measures how a model read the corpus, and a run that reads every
 * document costs no more than one that reads only the keyed passages (see cost.ts).
 */

import type { Corpus, Engine } from "@inspiration/engine";
import type { PredicateEntry } from "@inspiration/extraction";
import { sourcesOf } from "@inspiration/governance";
import type { Keys } from "./questions.ts";

/** Places as "<file>: <value>", sorted. */
export interface FactReading {
  found: string[];
  misread: string[];
  missed: string[];
  extra: string[];
}

export interface ReadingReport {
  facts: Record<string, FactReading>;
  /** Facts the catalogue has no entry for, with the places the key gives for them. */
  uncatalogued: Record<string, number>;
  totals: { stated: number; found: number; misread: number; missed: number; extra: number };
}

/** A keyed fact names a slot, "<subject>/<predicate>|<qualifier>...", the subject and qualifiers optional. */
export function predicateOfFact(fact: string): string {
  return fact.slice(fact.indexOf("/") + 1).split("|")[0] as string;
}

const NUMBER = /(?<![\d.,])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
const NUMERIC = new Set(["number", "money", "percent", "duration"]);
// The key's values are written in English (keys.yaml), so its words are matched here, not
// through language packs.
const NEGATED = /\b(?:not|no|never|none|without)\b|n't\b/i;
const BOUNDS = new Set([
  "",
  "more than",
  "less than",
  "fewer than",
  "over",
  "under",
  "up to",
  "within",
  "at most",
  "at least",
]);
const SIGNS: Record<string, string> = { $: "usd", us$: "usd", "€": "eur", "£": "gbp" };
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** "USD per person per event" is usd, then person and event; the order is the unit's meaning. */
const unitOf = (unit: string) => {
  const [per, ...each] = fold(unit)
    .replace(/ ?\bper\b ?/g, "/")
    .split("/");
  return { per: (per ?? "").trim(), each: each.map((e) => e.trim()) };
};
/** A word unit matches its plural; a symbol ("m", "ms", "s") matches only itself. */
const sameWord = (said: string, unit: string) =>
  said === unit || (unit.length > 2 && (said === `${unit}s` || said === `${unit}es`));

/**
 * A key's value as extraction writes it for the fact's catalogue entry, when the key's words
 * leave no doubt; otherwise the key's words, so a value read wrong is never counted as found.
 * A numeric entry takes the key's one number with the entry's unit ("more than 3 days" is
 * "3 day"); the key's unit must be the entry's, in the same order, or its currency alone
 * ("5,000 USD" for USD/transaction). An enum takes the one listed value the key names
 * ("stable since v1.25" is "stable"). A negation, a second number or enum value, brackets,
 * other units or currencies keep the key's words. A bound ("more than", "up to") is dropped as
 * extraction drops it: conditions a slot's value cannot hold are not checked here (issue #68).
 */
export function keyedForm(entry: Pick<PredicateEntry, "value"> | undefined, value: string): string {
  const v = entry?.value;
  if (!v || NEGATED.test(value)) return value;
  if (NUMERIC.has(v.kind)) {
    const numbers = [...value.matchAll(NUMBER)];
    const n = numbers[0];
    if (numbers.length !== 1 || n === undefined || /[()[\],;]/.test(value.replace(NUMBER, ""))) return value;
    let before = fold(value.slice(0, n.index));
    const after = unitOf(value.slice(n.index + n[0].length));
    const unit = unitOf(v.unit ?? "");
    const currency = v.currency === undefined ? undefined : fold(v.currency);
    const sign = before.match(/(?:^|\s)(us\$|\$|€|£|[a-z]{3})$/)?.[1];
    if (sign !== undefined && !BOUNDS.has(before)) {
      if ((SIGNS[sign] ?? sign) !== currency) return value;
      before = before.slice(0, -sign.length).trim();
    }
    if (!BOUNDS.has(before)) return value;
    const per = after.per === "" || sameWord(after.per, unit.per);
    // A key may leave the period out ("5,000 USD" for USD/transaction), never name another one.
    const each =
      after.each.length === 0 ||
      (after.each.length === unit.each.length && after.each.every((e, i) => sameWord(e, unit.each[i] as string)));
    if (!per || !each || (sign !== undefined && after.per !== "" && after.per !== currency)) return value;
    const number = String(Number(n[0].replaceAll(",", "")));
    return v.unit ? `${number} ${v.unit}` : number;
  }
  if (v.kind === "enum" && v.values?.length) {
    const listed = new Map(v.values.map((x) => [fold(x), x]));
    const named = new Set(
      fold(value)
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((w) => listed.has(w)),
    );
    if (named.size !== 1) return listed.get(fold(value)) ?? value;
    return listed.get([...named][0] as string) as string;
  }
  return value;
}

export async function readingReport(engine: Engine, corpus: Corpus, keys: Keys): Promise<ReadingReport> {
  // Governance names a document "<source>:<external ID>".
  const pathOf = (document: string) => {
    const at = document.indexOf(":");
    return at < 0 ? document : corpus.pathOf(document.slice(0, at), document.slice(at + 1));
  };
  const entries = new Map(corpus.vocabulary?.predicates.map((e) => [e.predicate, e]));
  const facts: Record<string, FactReading> = {};
  const uncatalogued: Record<string, number> = {};
  const totals = { stated: 0, found: 0, misread: 0, missed: 0, extra: 0 };
  for (const [fact, key] of Object.entries(keys.facts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = entries.get(predicateOfFact(fact));
    const stated = new Set(
      key.values.flatMap(({ value, stated }) =>
        value === null ? [] : stated.map((s) => `${s.file}: ${keyedForm(entry, value)}`),
      ),
    );
    if (!entry) {
      uncatalogued[fact] = stated.size;
      continue;
    }
    const { groups } = await engine.governance.slot(corpus.tenantId, fact);
    const read = new Set(
      groups.flatMap((g) =>
        sourcesOf(g)
          .flat()
          .map((d) => `${pathOf(d)}: ${g.value}`),
      ),
    );
    const files = new Set([...read].map((place) => place.slice(0, place.lastIndexOf(": "))));
    const r: FactReading = { found: [], misread: [], missed: [], extra: [] };
    for (const place of [...stated].sort()) {
      if (read.has(place)) r.found.push(place);
      else if (files.has(place.slice(0, place.lastIndexOf(": ")))) r.misread.push(place);
      else r.missed.push(place);
    }
    r.extra = [...read].filter((place) => !stated.has(place)).sort();
    facts[fact] = r;
    totals.stated += stated.size;
    totals.found += r.found.length;
    totals.misread += r.misread.length;
    totals.missed += r.missed.length;
    totals.extra += r.extra.length;
  }
  return { facts, uncatalogued, totals };
}

const EXTRAS_SHOWN = 5;
const percent = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "n/a");

export function readingLines(r: ReadingReport): string[] {
  const t = r.totals;
  const lines = [
    `reading: ${t.found} of ${t.stated} keyed statements found in their slot (recall ${percent(t.found, t.stated)}), ` +
      `${t.misread} misread, ${t.missed} missed; ${t.extra} values in keyed slots no key gives ` +
      `(precision ${percent(t.found, t.found + t.extra)})`,
  ];
  const left = Object.keys(r.uncatalogued);
  if (left.length) {
    const places = Object.values(r.uncatalogued).reduce((a, b) => a + b, 0);
    lines.push(
      `  not in the catalogue, so only answers find them: ${left.length} facts, ${places} places (${left.join(", ")})`,
    );
  }
  for (const [fact, f] of Object.entries(r.facts)) {
    // The JSON report has every extra; a stand-in reads a number in every sentence of an article.
    const off = [
      ...f.misread.map((p) => `misread ${p}`),
      ...f.missed.map((p) => `missed ${p}`),
      ...f.extra.slice(0, EXTRAS_SHOWN).map((p) => `extra ${p}`),
      ...(f.extra.length > EXTRAS_SHOWN ? [`and ${f.extra.length - EXTRAS_SHOWN} more extras`] : []),
    ];
    const of = f.found.length + f.misread.length + f.missed.length;
    if (off.length) lines.push(`  ${fact}: ${f.found.length} of ${of} found`, ...off.map((o) => `    ${o}`));
  }
  return lines;
}
