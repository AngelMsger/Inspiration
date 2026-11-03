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

// A number, with its sign unless the sign joins two numbers ("3-5").
const NUMBER = /(?<![\d.,])(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/;
const NUMERIC = new Set(["number", "money", "percent", "duration"]);
const NEGATION = new Set(["not", "no", "never", "without"]);
const fold = (s: string) => s.trim().toLowerCase();
/** A unit's parts: "USD per person per event" is usd, person, event; "addresses" is address. */
const unitParts = (unit: string) =>
  fold(unit)
    .replace(/\s+per\s+/g, "/")
    .split("/")
    .map((part) =>
      part
        .trim()
        .replace(/(ss|sh|ch|x)es$/, "$1")
        .replace(/(?<!s)s$/, ""),
    )
    .filter(Boolean);

/**
 * A key's value as extraction writes it for the entry, when the key's words leave no doubt: a
 * numeric entry's first number with the entry's unit ("more than 3 days" is "3 day"), an
 * enum's listed value the key names first ("stable since v1.25" is "stable"). A unit the
 * entry lacks ("15 USD/quarter" for USD/year) or a negated enum ("not stable") keeps the key's
 * words, as does any other value, so a misread never counts as found. Conditions the slot's
 * value cannot hold ("more than", "per segment") are not checked here (issue #68).
 */
export function keyedForm(entry: Pick<PredicateEntry, "value"> | undefined, value: string): string {
  const v = entry?.value;
  if (v && NUMERIC.has(v.kind)) {
    const m = NUMBER.exec(value);
    if (!m) return value;
    // The words after the number, to a comma or bracket, are the key's unit.
    const said = unitParts(value.slice(m.index + m[0].length).split(/[,;(]/)[0] ?? "");
    const known = new Set([...unitParts(v.unit ?? ""), ...(v.currency ? [fold(v.currency)] : [])]);
    if (said.some((part) => !known.has(part))) return value;
    const number = String(Number((m[1] as string).replaceAll(",", "")));
    return v.unit ? `${number} ${v.unit}` : number;
  }
  if (v?.kind === "enum" && v.values?.length) {
    const listed = new Map(v.values.map((x) => [fold(x), x]));
    const exact = listed.get(fold(value));
    if (exact) return exact;
    const words = fold(value).split(/[^\p{L}\p{N}-]+/u);
    const at = words.findIndex((w) => listed.has(w));
    if (at < 0 || NEGATION.has(words[at - 1] ?? "")) return value;
    return listed.get(words[at] as string) as string;
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
