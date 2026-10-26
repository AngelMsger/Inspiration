/**
 * The control check: a small corpus whose every case has one right answer (examples/control),
 * measured case by case rather than by a single truth count. For each slot a case looks at it
 * reports which documents put which value in the slot (so a statement that lands in the wrong
 * slot shows), how many independent sources support each value once copies count once, the
 * value governance proposes and what becomes of every other value.
 *
 * expected.yaml beside the corpus gives the answers in the same shape: each value with its
 * documents grouped by independent source, the proposed value and the other values' outcome.
 * Its `engine` entries record where the engine gets a case otherwise today, and why; the
 * control test holds the run to them, so a change that closes or opens a gap shows in a diff
 * of that file.
 *
 * The observed side comes from the run: the documents from governance's value groups, the
 * sources from normalization's duplicate report (documents it found to be copies of one
 * another count once), the proposal and the other values' cases from governance's decision.
 * Governance itself counts statements, not sources; the report prints both.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { schemaErrors, slotOf, valueKeyOf } from "@inspiration/contracts";
import { type CaseDraft, governedAsOf } from "@inspiration/governance";
import { parse } from "yaml";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";
import type { IngestReport } from "./ingest.ts";

/** A slot as the answers give it or as a run leaves it. */
export interface SlotOutcome {
  /** Each value's sources, each source its documents: the original first, then its copies. */
  values: Record<string, string[][]>;
  proposed?: string;
  /** Every other value: "note", or the case's status and class ("open contradiction"). */
  cases: Record<string, string>;
}

export interface ControlCase {
  case: string;
  group: string;
  question: string;
  slots: Record<string, SlotOutcome>;
  /** Where the engine gets the case otherwise today: the fields that differ, per slot; null for none. */
  engine?: { why: string; slots: Record<string, { [K in keyof SlotOutcome]?: SlotOutcome[K] | null }> };
}

export interface Control {
  cases: ControlCase[];
}

export class ControlError extends Error {
  override name = "ControlError";
}

const SOURCES = { type: "object", additionalProperties: { type: "array", items: { type: "array", minItems: 1 } } };
const CASES = { type: "object", additionalProperties: { type: "string" } };
const SCHEMA = {
  type: "object",
  required: ["cases"],
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        required: ["case", "group", "question", "slots"],
        properties: {
          case: { type: "string", minLength: 1 },
          group: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          slots: {
            type: "object",
            minProperties: 1,
            additionalProperties: {
              type: "object",
              required: ["values"],
              properties: { values: SOURCES, proposed: { type: "string" }, cases: CASES },
              additionalProperties: false,
            },
          },
          engine: {
            type: "object",
            required: ["why", "slots"],
            properties: {
              why: { type: "string", minLength: 1 },
              slots: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    values: SOURCES,
                    proposed: { type: ["string", "null"] },
                    cases: { ...CASES, type: ["object", "null"] },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
  },
};

/** The answers in a corpus's expected.yaml, or undefined when it has none. */
export async function loadControl(dir: string): Promise<Control | undefined> {
  const text = await readFile(join(dir, "expected.yaml"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const value: unknown = parse(text);
  const errors = schemaErrors(SCHEMA, value);
  if (errors.length) throw new ControlError(`invalid expected.yaml: ${errors.join("; ")}`);
  const control = value as Control;
  for (const c of control.cases) {
    for (const slot of Object.keys(c.engine?.slots ?? {})) {
      if (!c.slots[slot]) throw new ControlError(`${c.case}: engine entry for ${slot}, which the case does not expect`);
    }
  }
  return control;
}

/** What governance counts for a value: statements, the governed ones in effect today, documents. */
export interface ValueCounts {
  statements: number;
  governed: number;
  documents: number;
}

export interface CaseResult {
  case: string;
  group: string;
  question: string;
  expected: Record<string, SlotOutcome>;
  /** The answers with the engine's recorded differences in their place. */
  recorded: Record<string, SlotOutcome>;
  observed: Record<string, SlotOutcome>;
  counts: Record<string, Record<string, ValueCounts>>;
  why?: string;
}

export interface ControlReport {
  cases: CaseResult[];
  /** Slots no case looks at, as the run left them. */
  unexpected: Record<string, SlotOutcome>;
  totals: {
    cases: number;
    /** Cases the run gets right, and those it gets as the engine entries record. */
    as_expected: number;
    as_recorded: number;
    /** Statements the answers place, those in their slot with their value, and those placed elsewhere. */
    statements: { expected: number; in_slot: number; misplaced: number };
    /** Values the answers give, and those whose independent sources match. */
    values: { expected: number; sources_right: number };
    /** Slots the answers give, those with the expected proposal and those with the expected cases. */
    slots: { expected: number; proposed_right: number; cases_right: number };
  };
}

/** An outcome with its defaults and its lists sorted, so two compare equal however they were written. */
function canonical(o: Partial<SlotOutcome>): SlotOutcome {
  const values = Object.fromEntries(
    Object.entries(o.values ?? {})
      .map(([v, sources]): [string, string[][]] => [
        v,
        sources.map((s) => [...s].sort()).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
      ])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    values,
    ...(o.proposed !== undefined && { proposed: o.proposed }),
    cases: Object.fromEntries(Object.entries(o.cases ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

function recorded(c: ControlCase): Record<string, SlotOutcome> {
  return Object.fromEntries(
    Object.entries(c.slots).map(([slot, expected]) => {
      const merged: Partial<SlotOutcome> = { ...expected };
      for (const [field, value] of Object.entries(c.engine?.slots[slot] ?? {})) {
        if (value === null) delete merged[field as keyof SlotOutcome];
        else Object.assign(merged, { [field]: value });
      }
      return [slot, canonical(merged)];
    }),
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Documents normalization found to be copies of one another, as one representative each. */
function copiesOf(duplicates: IngestReport["duplicates"]): (path: string) => string {
  const parent = new Map<string, string>();
  const root = (p: string): string => {
    const up = parent.get(p);
    if (up === undefined || up === p) return p;
    const top = root(up);
    parent.set(p, top);
    return top;
  };
  for (const d of duplicates) {
    const [a, b] = [root(d.document), root(d.duplicate_of)];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  return root;
}

const caseOutcome = (c: CaseDraft) => (c.note ? "note" : `${c.status} ${c.classification}`);

export async function controlReport(
  engine: Engine,
  corpus: Corpus,
  control: Control,
  duplicates: IngestReport["duplicates"],
): Promise<ControlReport> {
  const tenantId = corpus.tenantId;
  const today = engine.governance.clock().toISOString().slice(0, 10);
  const sourceOf = copiesOf(duplicates);
  const paths = new Map<string, string>();
  const pathOf = async (versionId: string) => {
    if (!paths.has(versionId)) {
      const v = await engine.store.getSourceVersion(versionId);
      paths.set(versionId, v ? corpus.pathOf(v.source_id, v.external_id) : versionId);
    }
    return paths.get(versionId) as string;
  };

  const observe = async (slot: string) => {
    const { groups, decision } = await engine.governance.slot(tenantId, slot);
    const values: SlotOutcome["values"] = {};
    const counts: Record<string, ValueCounts> = {};
    for (const g of groups) {
      const bySource = new Map<string, string[]>();
      for (const id of g.versions) {
        const path = await pathOf(id);
        const source = sourceOf(path);
        bySource.set(source, [...(bySource.get(source) ?? []), path]);
      }
      values[g.value] = [...bySource.values()];
      counts[g.value] = { statements: g.count, governed: governedAsOf(g, today), documents: g.versions.length };
    }
    const proposed = decision?.proposed.value ?? (groups.length === 1 ? groups[0]?.value : undefined);
    const cases = Object.fromEntries((decision?.cases ?? []).map((c) => [c.value, caseOutcome(c)]));
    return { outcome: canonical({ values, ...(proposed !== undefined && { proposed }), cases }), counts };
  };

  const looked = new Set(control.cases.flatMap((c) => Object.keys(c.slots)));
  // A control corpus is small: one page of claims holds all of them.
  const claims = await engine.store.asOf({ space_ids: corpus.manifest.spaces.map((s) => s.id) });
  const slots = new Set(claims.flatMap((c) => (valueKeyOf(c) !== undefined ? (slotOf(c) ?? []) : [])));
  const unexpected: ControlReport["unexpected"] = {};
  for (const slot of [...slots].sort()) if (!looked.has(slot)) unexpected[slot] = (await observe(slot)).outcome;

  const totals: ControlReport["totals"] = {
    cases: control.cases.length,
    as_expected: 0,
    as_recorded: 0,
    statements: { expected: 0, in_slot: 0, misplaced: 0 },
    values: { expected: 0, sources_right: 0 },
    slots: { expected: 0, proposed_right: 0, cases_right: 0 },
  };
  const triples = (slot: string, o: SlotOutcome) =>
    Object.entries(o.values).flatMap(([v, sources]) => sources.flat().map((d) => `${d}\n${slot}\n${v}`));
  for (const [slot, o] of Object.entries(unexpected)) totals.statements.misplaced += triples(slot, o).length;

  const cases: CaseResult[] = [];
  for (const c of control.cases) {
    const expected = Object.fromEntries(Object.entries(c.slots).map(([slot, o]) => [slot, canonical(o)]));
    const observed: CaseResult["observed"] = {};
    const counts: CaseResult["counts"] = {};
    for (const slot of Object.keys(c.slots)) {
      const seen = await observe(slot);
      observed[slot] = seen.outcome;
      counts[slot] = seen.counts;
      const want = expected[slot] as SlotOutcome;
      const got = new Set(triples(slot, seen.outcome));
      const placed = new Set(triples(slot, want));
      totals.statements.expected += placed.size;
      totals.statements.in_slot += [...placed].filter((t) => got.has(t)).length;
      totals.statements.misplaced += [...got].filter((t) => !placed.has(t)).length;
      for (const [v, sources] of Object.entries(want.values)) {
        totals.values.expected++;
        if (same(sources, seen.outcome.values[v])) totals.values.sources_right++;
      }
      totals.slots.expected++;
      if (want.proposed === seen.outcome.proposed) totals.slots.proposed_right++;
      if (same(want.cases, seen.outcome.cases)) totals.slots.cases_right++;
    }
    const result: CaseResult = {
      case: c.case,
      group: c.group,
      question: c.question,
      expected,
      recorded: recorded(c),
      observed,
      counts,
      ...(c.engine && { why: c.engine.why }),
    };
    if (same(observed, expected)) totals.as_expected++;
    if (same(observed, result.recorded)) totals.as_recorded++;
    cases.push(result);
  }
  return { cases, unexpected, totals };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What became of a value in a slot. */
function role(o: SlotOutcome, value: string): string {
  if (value === o.proposed) return "proposed";
  return o.cases[value] ?? (o.values[value] ? "no case" : "not stated");
}

function slotLines(slot: string, r: CaseResult): string[] {
  const want = r.expected[slot] as SlotOutcome;
  const got = r.observed[slot] as SlotOutcome;
  const unless = (differs: boolean, what: string) => (differs ? ` (expected ${what})` : "");
  const lines = [`    ${slot}:`];
  for (const v of [...new Set([...Object.keys(want.values), ...Object.keys(got.values)])].sort()) {
    const [is, was] = [role(got, v), role(want, v)];
    const sources = got.values[v] ?? [];
    const expected = want.values[v] ?? [];
    const n = r.counts[slot]?.[v];
    const counted = n
      ? `; governance counts ${plural(n.statements, "statement")}, ${n.governed} governed in effect, in ${plural(n.documents, "document")}`
      : "";
    lines.push(
      `      ${v}: ${is}${unless(is !== was, was)}, ${plural(sources.length, "source")}` +
        `${unless(!same(sources, expected), plural(expected.length, "source"))}${counted}`,
    );
  }
  if (!got.proposed && want.proposed) lines.push(`      nothing proposed (expected ${want.proposed})`);
  return lines;
}

export function controlLines(r: ControlReport): string[] {
  const t = r.totals;
  const lines = [
    `control: ${t.cases} cases, ${t.as_expected} as expected; ${t.as_recorded - t.as_expected} differ as expected.yaml records, ${t.cases - t.as_recorded} otherwise`,
    `  statements: ${t.statements.in_slot} of ${t.statements.expected} in their slot with their value, ${t.statements.misplaced} in a slot or with a value they do not have`,
    `  sources: ${t.values.sources_right} of ${t.values.expected} values with the expected independent sources (copies count once)`,
    `  slots: proposed value as expected in ${t.slots.proposed_right} of ${t.slots.expected}, the other values' outcome in ${t.slots.cases_right}`,
  ];
  for (const c of r.cases) {
    const state = same(c.observed, c.expected) ? "right" : same(c.observed, c.recorded) ? "known gap" : "differs";
    lines.push(`  ${state}: ${c.case} (${c.group}). ${c.question}`);
    for (const slot of Object.keys(c.expected)) lines.push(...slotLines(slot, c));
    if (c.why && state !== "right") lines.push(`    why: ${c.why}`);
  }
  for (const [slot, o] of Object.entries(r.unexpected)) {
    lines.push(`  unexpected slot ${slot}: ${Object.keys(o.values).join(", ")}`);
  }
  return lines;
}
