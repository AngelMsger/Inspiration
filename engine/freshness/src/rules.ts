/**
 * How long knowledge stays fresh, and how stale a document is on a day: the pure part of
 * freshness.
 *
 * Each knowledge class has a review interval in days (a tenant may set its own). A document
 * is due for review when the shortest interval among the classes of its current claims has
 * passed since it last changed; plans do not count, and a class without an interval
 * ("general") never makes a document due. A document that carries its own date (minutes,
 * reports) is a record of that day and is never due.
 *
 * Staleness is a score, not a flag: the largest of
 * - age: the share of the review interval that has passed, up to 1;
 * - upstream: 1 while a document it repeats has changed and it has not;
 * - assumption: 1 once a day one of its plans named has come.
 * Its state is at_risk when upstream or assumption is 1, else stale once the interval has
 * passed, aging from AGING of it, and fresh before.
 */

import type { FreshnessState, Staleness } from "@inspiration/contracts";

/** Review intervals in days by knowledge class; null for a class that is never due by age. */
export type ReviewIntervals = Readonly<Record<string, number | null>>;

export const DEFAULT_INTERVALS: ReviewIntervals = {
  policy: 365,
  process: 180,
  product: 180,
  org: 180,
  technical: 180,
  pricing: 90,
  market: 90,
  general: null,
};

/** Share of the review interval from which a document counts as aging. */
export const AGING = 0.75;

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of an instant. */
export const dayOf = (instant: string | Date) =>
  (typeof instant === "string" ? instant : instant.toISOString()).slice(0, 10);

export function addDays(day: string, days: number): string {
  return dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The class with the shortest interval among the given ones, and that interval. */
export function reviewInterval(
  classes: Iterable<string>,
  intervals: ReviewIntervals,
): { knowledge_class: string; days: number } | undefined {
  let best: { knowledge_class: string; days: number } | undefined;
  for (const c of classes) {
    const days = c in intervals ? intervals[c] : intervals.general;
    if (days === null || days === undefined) continue;
    if (!best || days < best.days || (days === best.days && c < best.knowledge_class))
      best = { knowledge_class: c, days };
  }
  return best;
}

/** What staleness is computed from: a document's clock and flags, as of a day. */
export interface Clock {
  /** The day the document last changed. */
  changed_on: string;
  interval_days?: number;
  /** A document it repeats changed after it. */
  behind: boolean;
  /** A day one of its plans named has come. */
  lapsed: boolean;
}

export function staleness(unitId: string, clock: Clock, now: Date): Staleness {
  const today = dayOf(now);
  const age = clock.interval_days
    ? Math.min(1, Math.max(0, daysBetween(clock.changed_on, today) / clock.interval_days))
    : 0;
  const upstream = clock.behind ? 1 : 0;
  const assumption = clock.lapsed ? 1 : 0;
  let state: FreshnessState = "fresh";
  if (upstream || assumption) state = "at_risk";
  else if (age >= 1) state = "stale";
  else if (age >= AGING) state = "aging";
  const out: Staleness = {
    unit_id: unitId,
    score: Math.round(Math.max(age, upstream, assumption) * 1000) / 1000,
    state,
    age_component: Math.round(age * 1000) / 1000,
    upstream_component: upstream,
    assumption_component: assumption,
    computed_at: now.toISOString(),
  };
  if (clock.interval_days) {
    out.ttl = `P${clock.interval_days}D`;
    out.review_due = `${addDays(clock.changed_on, clock.interval_days)}T00:00:00Z`;
  }
  return out;
}
