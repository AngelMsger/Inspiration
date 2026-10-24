/**
 * The freshness part of a run report: which documents have a review clock and which class
 * sets it, when their reviews fall due, how stale they are now, which plan days are still
 * ahead, and the reviews the run published, per source update for an edit round.
 *
 * days() runs the engine's daily tick over a span of simulated days after a run, so the UI
 * work can size the review queue: what is due at once (the backlog), then reviews per day
 * and per week, and the slots governance decided again because a dated change took effect.
 */

import type { EventEnvelope, ReviewDue } from "@inspiration/contracts";
import { addDays, clockOf, dayOf, daysBetween, staleness } from "@inspiration/freshness";
import { type Spread, spread } from "./claims.ts";
import type { Engine } from "./engine.ts";

export interface FreshnessReport {
  documents: number;
  /** Documents with a review interval, by the class that sets it. */
  by_review_class: Record<string, number>;
  /** Documents never due by age. */
  never_due: { dated: number; archived: number; no_interval: number };
  /** Days from today to each scheduled ttl review; 0 or less is due now. */
  review_in_days: Spread;
  /** ttl reviews due by today that the daily tick has not published yet. */
  overdue: number;
  /** Plan days still ahead, and the documents that have them. */
  plans_ahead: { days: number; documents: number };
  /** Current documents by staleness state. */
  states: Record<string, number>;
  /** review.due events the run published, by kind. */
  reviews: Record<string, number>;
  /** Source updates (versions with a previous one), and the reviews each caused at once. */
  edits: number;
  edits_with_reviews: number;
  reviews_per_edit: Spread;
}

export interface DaysReport {
  from: string;
  to: string;
  /** Reviews published by the first tick: what was due when the run ended. */
  backlog: Record<string, number>;
  /** Reviews marked backlog (already due when their document arrived), on any day: a first-review campaign. */
  campaign: number;
  /** Reviews published by the later ticks, by kind. */
  reviews: Record<string, number>;
  per_day: Spread;
  per_week: Spread;
  busiest: { day: string; reviews: number };
  /** Slots governance decided again because a dated change took effect, and the todo requests that made. */
  rechecked_slots: number;
  recheck_requests: number;
  /** Current documents by staleness state on the last day. */
  states_at_end: Record<string, number>;
}

/** A clock a run moves by hand: the engine's "now" for governance and freshness. */
export class SimulatedClock {
  #now: Date;

  constructor(start: Date) {
    this.#now = start;
  }

  readonly now = (): Date => this.#now;

  set(day: string): void {
    this.#now = new Date(`${day}T09:00:00Z`);
  }
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

async function states(engine: Engine, tenantId: string): Promise<Record<string, number>> {
  const now = engine.freshness.clock();
  const out: Record<string, number> = {};
  for (const d of await engine.freshness.documents(tenantId)) {
    if (!d.archived) bump(out, staleness(d.source_version_id, clockOf(d), now).state);
  }
  return out;
}

export async function freshnessReport(
  engine: Engine,
  tenantId: string,
  run: { reviews: readonly EventEnvelope[]; changes: readonly EventEnvelope[] },
): Promise<FreshnessReport> {
  const today = dayOf(engine.freshness.clock());
  const documents = await engine.freshness.documents(tenantId);
  const upcoming = await engine.freshness.upcoming(tenantId);
  const report: FreshnessReport = {
    documents: documents.length,
    by_review_class: {},
    never_due: { dated: 0, archived: 0, no_interval: 0 },
    review_in_days: spread([]),
    overdue: 0,
    plans_ahead: { days: 0, documents: 0 },
    states: await states(engine, tenantId),
    reviews: {},
    edits: 0,
    edits_with_reviews: 0,
    reviews_per_edit: spread([]),
  };
  for (const d of documents) {
    if (d.archived) report.never_due.archived++;
    else if (d.dated) report.never_due.dated++;
    else if (!d.review_class) report.never_due.no_interval++;
    else bump(report.by_review_class, d.review_class);
  }
  const ttl = upcoming.filter((d) => d.kind === "ttl");
  report.review_in_days = spread(ttl.map((d) => daysBetween(today, d.day)));
  report.overdue = ttl.filter((d) => d.day <= today).length;
  const plans = upcoming.filter((d) => d.kind === "assumption" && d.day > today);
  report.plans_ahead = { days: plans.length, documents: new Set(plans.map((d) => d.document)).size };

  const perEdit = new Map<string, number>();
  for (const e of run.reviews) {
    bump(report.reviews, (e.data as unknown as ReviewDue).kind);
    if (e.causation_id) perEdit.set(e.causation_id, (perEdit.get(e.causation_id) ?? 0) + 1);
  }
  const edits = run.changes.filter((e) => (e.data as { previous_version_id?: string }).previous_version_id);
  report.edits = edits.length;
  report.edits_with_reviews = edits.filter((e) => perEdit.has(e.id)).length;
  report.reviews_per_edit = spread(edits.map((e) => perEdit.get(e.id) ?? 0));
  return report;
}

/** Tick once a day from the clock's day for the given number of days, and report. */
export async function days(
  engine: Engine,
  tenantId: string,
  clock: SimulatedClock,
  count: number,
): Promise<DaysReport> {
  const from = dayOf(clock.now());
  const report: DaysReport = {
    from,
    to: addDays(from, count - 1),
    backlog: {},
    campaign: 0,
    reviews: {},
    per_day: spread([]),
    per_week: spread([]),
    busiest: { day: from, reviews: 0 },
    rechecked_slots: 0,
    recheck_requests: 0,
    states_at_end: {},
  };
  const perDay: number[] = [];
  const perWeek: number[] = [];
  for (let i = 0; i < count; i++) {
    const day = addDays(from, i);
    clock.set(day);
    const { reviews, rechecked } = await engine.tick(tenantId);
    report.rechecked_slots += rechecked.slots.length;
    report.recheck_requests += rechecked.requests.length;
    report.campaign += reviews.filter((r) => r.backlog).length;
    if (i === 0) {
      for (const r of reviews) bump(report.backlog, r.kind);
      continue;
    }
    for (const r of reviews) bump(report.reviews, r.kind);
    perDay.push(reviews.length);
    if ((i - 1) % 7 === 0) perWeek.push(0);
    perWeek[perWeek.length - 1] = (perWeek.at(-1) ?? 0) + reviews.length;
    if (reviews.length > report.busiest.reviews) report.busiest = { day, reviews: reviews.length };
  }
  report.per_day = spread(perDay);
  report.per_week = spread(perWeek);
  report.states_at_end = await states(engine, tenantId);
  return report;
}
