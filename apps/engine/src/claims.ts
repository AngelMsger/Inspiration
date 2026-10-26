/**
 * The claims part of a run report: how many claims extraction produced per document and
 * governance level, and the model calls each level took, how many landed in a slot, which slots disagree on a value, what a claim
 * merge would leave, what the model calls cost, and, for a synthesized corpus, how many of
 * the facts in truth.json came out with the right value.
 */

import {
  type BlocksChanged,
  type Claim,
  type ClaimsUpdated,
  type GovernanceLevel,
  levelOf,
  type SourceVersion,
  slotOf,
  type UsageRecord,
  valueKeyOf,
} from "@inspiration/contracts";
import { TASK } from "@inspiration/extraction";
import { Gateway, MemoryUsage } from "@inspiration/model-gateway";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";

export interface Spread {
  median: number;
  p90: number;
  max: number;
}

export function spread(values: readonly number[]): Spread {
  if (!values.length) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { median: at(0.5), p90: at(0.9), max: sorted.at(-1) as number };
}

export interface ClaimsReport {
  /** Current claims this run added, and claims it closed. */
  added: number;
  closed: number;
  windows: number;
  failed_windows: number;
  /** Claims the model returned without a verbatim quote. */
  rejected: number;
  /** Claims of reference documents outside any slot, left unwritten until a passage is used. */
  unused: number;
  per_document: Spread;
  /** Documents, claims and model calls by the documents' governance level. */
  by_level: Partial<
    Record<GovernanceLevel, { documents: number; claims: number; windows: number; per_document: Spread }>
  >;
  by_type: Record<string, number>;
  by_class: Record<string, number>;
  /** Claims with a predicate, those with a value too, and the distinct slots. */
  in_slot: number;
  with_value: number;
  slots: number;
  /** Slots whose current claims state more than one value. */
  conflicts: { slots: number; claims: number; top: { slot: string; values: Record<string, number> }[] };
  /**
   * What a claim merge would leave: one claim per slot and value, and one per distinct
   * statement (ignoring spaces and punctuation) for the rest.
   */
  after_merging: number;
  models: {
    calls: number;
    cached: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    by_route: Record<string, number>;
  };
  truth?: TruthCheck;
}

export interface TruthCheck {
  /** Fact statements in truth.json, and those a claim of the same document matched. */
  statements: number;
  found: number;
  /** A claim of the document has the fact's slot, but another value. */
  wrong_value: number;
  missed: number;
  by_stance: Record<string, { statements: number; found: number }>;
  /** By the level of the statement's document. */
  by_level: Partial<Record<GovernanceLevel, { statements: number; found: number }>>;
}

export interface Truth {
  facts: { key: string; value: string; slot: string }[];
  statements: { document: string; fact: string; value: string; stance: string; from?: string }[];
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

const STRIP = /[\s\p{P}\p{S}]/gu;

function sameValue(claim: Claim, value: string): boolean {
  if (!claim.value) return false;
  if (claim.value.number !== undefined) return claim.value.number === Number.parseFloat(value);
  return claim.value.text === value;
}

/** Usage records of extraction calls made after `from`, when the engine meters in memory. */
function extractionCalls(engine: Engine, from: number): UsageRecord[] {
  const models = engine.models;
  if (!(models instanceof Gateway) || !(models.usage instanceof MemoryUsage)) return [];
  return models.usage.records.slice(from).filter((r) => r.task === TASK);
}

/** The engine's metered call count, to pass to claimsReport as `from` before a run. */
export function usageMark(engine: Engine): number {
  const models = engine.models;
  return models instanceof Gateway && models.usage instanceof MemoryUsage ? models.usage.records.length : 0;
}

export async function claimsReport(
  engine: Engine,
  corpus: Corpus,
  run: {
    changes: readonly BlocksChanged[];
    updates: readonly ClaimsUpdated[];
    totals: {
      windows: number;
      failed_windows: number;
      rejected: number;
      unused: number;
      windows_by_level: Record<GovernanceLevel, number>;
    };
    usageFrom: number;
    truth?: Truth;
  },
): Promise<ClaimsReport> {
  const versions = new Map<string, SourceVersion | undefined>();
  const versionOf = async (id: string) => {
    if (!versions.has(id)) versions.set(id, await engine.store.getSourceVersion(id));
    return versions.get(id);
  };
  const closed = new Set(run.updates.flatMap((u) => u.superseded));
  const versionOfClaim = new Map<string, string>();
  for (const u of run.updates) {
    for (const id of u.added) if (u.source_version_id && !closed.has(id)) versionOfClaim.set(id, u.source_version_id);
  }
  const claims: Claim[] = [];
  const ids = [...versionOfClaim.keys()];
  for (let i = 0; i < ids.length; i += 500) claims.push(...(await engine.store.getClaims(ids.slice(i, i + 500))));

  const perVersion = new Map<string, Claim[]>();
  for (const c of claims) {
    const v = versionOfClaim.get(c.id) as string;
    perVersion.set(v, [...(perVersion.get(v) ?? []), c]);
  }
  const counts: number[] = [];
  const byLevel: Partial<Record<GovernanceLevel, number[]>> = {};
  const pathOf = new Map<string, string>();
  const levelOfPath = new Map<string, GovernanceLevel>();
  for (const change of run.changes) {
    if (change.deleted) continue;
    const version = await versionOf(change.source_version_id);
    if (!version) continue;
    const path = corpus.pathOf(version.source_id, version.external_id);
    pathOf.set(version.id, path);
    const n = perVersion.get(version.id)?.length ?? 0;
    counts.push(n);
    const level = levelOf(version);
    levelOfPath.set(path, level);
    byLevel[level] = [...(byLevel[level] ?? []), n];
  }

  const byType: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const values = new Map<string, Record<string, number>>();
  const merged = new Set<string>();
  let inSlot = 0;
  let withValue = 0;
  for (const c of claims) {
    bump(byType, c.claim_type);
    bump(byClass, c.knowledge_class);
    const slot = slotOf(c);
    const value = valueKeyOf(c);
    if (slot) inSlot++;
    if (slot && value !== undefined) {
      withValue++;
      const seen = values.get(slot) ?? {};
      bump(seen, value);
      values.set(slot, seen);
      merged.add(`${slot}=${value}`);
    } else merged.add(c.statement.replace(STRIP, ""));
  }
  const slots = new Set(claims.flatMap((c) => slotOf(c) ?? []));
  const disagreeing = [...values].filter(([, v]) => Object.keys(v).length > 1);
  const total = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0);

  const calls = extractionCalls(engine, run.usageFrom);
  const byRoute: Record<string, number> = {};
  for (const r of calls) bump(byRoute, `${r.provider ?? "?"}/${r.model ?? "?"}`);

  const { windows_by_level, ...totals } = run.totals;
  const report: ClaimsReport = {
    added: claims.length,
    closed: closed.size,
    ...totals,
    per_document: spread(counts),
    by_level: Object.fromEntries(
      Object.entries(byLevel).map(([k, ns]) => [
        k,
        {
          documents: ns.length,
          claims: ns.reduce((a, b) => a + b, 0),
          windows: windows_by_level[k as GovernanceLevel],
          per_document: spread(ns),
        },
      ]),
    ),
    by_type: byType,
    by_class: byClass,
    in_slot: inSlot,
    with_value: withValue,
    slots: slots.size,
    conflicts: {
      slots: disagreeing.length,
      claims: disagreeing.reduce((n, [, v]) => n + total(v), 0),
      top: disagreeing
        .sort(([, a], [, b]) => total(b) - total(a))
        .slice(0, 10)
        .map(([slot, v]) => ({ slot, values: v })),
    },
    after_merging: merged.size,
    models: {
      calls: calls.length,
      cached: calls.filter((r) => r.status === "cached").length,
      input_tokens: calls.reduce((n, r) => n + r.usage.input_tokens, 0),
      output_tokens: calls.reduce((n, r) => n + r.usage.output_tokens, 0),
      cost: Math.round(calls.reduce((n, r) => n + r.cost.amount, 0) * 100) / 100,
      by_route: byRoute,
    },
  };
  if (run.truth) report.truth = checkTruth(run.truth, perVersion, pathOf, levelOfPath);
  return report;
}

function checkTruth(
  truth: Truth,
  perVersion: Map<string, Claim[]>,
  pathOf: Map<string, string>,
  levelOfPath: Map<string, GovernanceLevel>,
): TruthCheck {
  const byPath = new Map<string, Claim[]>();
  for (const [version, claims] of perVersion) {
    const path = pathOf.get(version);
    if (path) byPath.set(path, [...(byPath.get(path) ?? []), ...claims]);
  }
  const slotOfFact = new Map(truth.facts.map((f) => [f.key, f.slot]));
  const check: TruthCheck = { statements: 0, found: 0, wrong_value: 0, missed: 0, by_stance: {}, by_level: {} };
  for (const s of truth.statements) {
    const stance = check.by_stance[s.stance] ?? { statements: 0, found: 0 };
    check.by_stance[s.stance] = stance;
    const level = levelOfPath.get(s.document) ?? "governed";
    const atLevel = check.by_level[level] ?? { statements: 0, found: 0 };
    check.by_level[level] = atLevel;
    check.statements++;
    stance.statements++;
    atLevel.statements++;
    const candidates = (byPath.get(s.document) ?? []).filter((c) => slotOf(c) === slotOfFact.get(s.fact));
    if (candidates.some((c) => sameValue(c, s.value))) {
      check.found++;
      stance.found++;
      atLevel.found++;
    } else if (candidates.length) check.wrong_value++;
    else check.missed++;
  }
  return check;
}
