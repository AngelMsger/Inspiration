/**
 * The governance part of a run report: the conflict cases it found by class and status,
 * the todos they would make once collaboration merges requests by dedupe key, how many
 * todo requests each source update caused, how many values a person chooses between per
 * todo, and, for a synthesized corpus, whether the proposed value of each fact is the one
 * the synthesizer made current (its latest decision in force, else the policy's value).
 */

import type { EventEnvelope, TodoRequested } from "@inspiration/contracts";
import { type Spread, spread, type Truth } from "./claims.ts";
import type { Engine } from "./engine.ts";

export interface GovernanceReport {
  cases: { total: number; by_class: Record<string, number>; by_status: Record<string, number> };
  /** Slots with open cases at the end of the run: one todo each. */
  todos: number;
  todos_by_priority: Record<string, number>;
  /** Values a person chooses between, per todo. */
  values_per_todo: Spread;
  /** Why each conflicting slot's proposed value holds. */
  proposed_by: Record<string, number>;
  /** todo.requested events, and the claims updates that caused them. */
  requests: number;
  updates: number;
  updates_with_requests: number;
  requests_per_update: Spread;
  truth?: GovernanceTruth;
}

export interface GovernanceTruth {
  /** Facts whose slot governance decided, and those where it proposed the expected value. */
  slots: number;
  expected: number;
  /** Facts whose latest decisions in force tie on the day with different values. */
  ambiguous: number;
  mismatches: { slot: string; proposed: string; expected: string[] }[];
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

const sameValue = (key: string, value: string) =>
  key === value || (Number.parseFloat(key) === Number.parseFloat(value) && !Number.isNaN(Number.parseFloat(value)));

export async function governanceReport(
  engine: Engine,
  tenantId: string,
  run: { requests: readonly EventEnvelope[]; updates: readonly EventEnvelope[]; truth?: Truth },
): Promise<GovernanceReport> {
  const cases = await engine.governance.conflicts(tenantId);
  const byClass: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const openSlots = new Map<string, number>();
  for (const c of cases) {
    bump(byClass, c.classification);
    bump(byStatus, c.status);
    if (c.status === "open" && c.batch_key) openSlots.set(c.batch_key, (openSlots.get(c.batch_key) ?? 0) + 1);
  }
  // A todo shows the slot's last request: its priority stands until a new one replaces it.
  const last = new Map<string, TodoRequested>();
  for (const e of run.requests) {
    const r = e.data as unknown as TodoRequested;
    last.set(r.dedupe_key, r);
  }
  const byPriority: Record<string, number> = {};
  for (const slot of openSlots.keys()) {
    const r = last.get(`governance:conflict:${slot}`);
    bump(byPriority, r?.priority ?? "unknown");
  }
  const proposedBy: Record<string, number> = {};
  const decided = new Map<string, string>();
  const slots = new Set(cases.flatMap((c) => c.batch_key ?? []));
  for (const slot of slots) {
    const { decision } = await engine.governance.slot(tenantId, slot);
    if (!decision) continue;
    bump(proposedBy, decision.basis);
    decided.set(slot, decision.proposed.value);
  }
  const perUpdate = new Map<string, number>();
  for (const e of run.requests)
    if (e.causation_id) perUpdate.set(e.causation_id, (perUpdate.get(e.causation_id) ?? 0) + 1);
  const report: GovernanceReport = {
    cases: { total: cases.length, by_class: byClass, by_status: byStatus },
    todos: openSlots.size,
    todos_by_priority: byPriority,
    values_per_todo: spread([...openSlots.values()].map((n) => n + 1)),
    proposed_by: proposedBy,
    requests: run.requests.length,
    updates: run.updates.length,
    updates_with_requests: perUpdate.size,
    requests_per_update: spread(run.updates.map((u) => perUpdate.get(u.id) ?? 0)),
  };
  if (run.truth)
    report.truth = checkProposals(run.truth, decided, engine.governance.clock().toISOString().slice(0, 10));
  return report;
}

function checkProposals(truth: Truth, decided: Map<string, string>, today: string): GovernanceTruth {
  const check: GovernanceTruth = { slots: 0, expected: 0, ambiguous: 0, mismatches: [] };
  for (const fact of truth.facts) {
    const proposed = decided.get(fact.slot);
    if (proposed === undefined) continue;
    check.slots++;
    const decisions = truth.statements.filter(
      (s) => s.fact === fact.key && s.stance === "decision" && s.from !== undefined && s.from <= today,
    );
    const latest = decisions.reduce((day, s) => ((s.from as string) > day ? (s.from as string) : day), "");
    const expected = latest
      ? [...new Set(decisions.filter((s) => s.from === latest).map((s) => s.value))]
      : [fact.value];
    if (expected.length > 1) check.ambiguous++;
    if (expected.some((v) => sameValue(proposed, v))) check.expected++;
    else check.mismatches.push({ slot: fact.slot, proposed, expected });
  }
  return check;
}
