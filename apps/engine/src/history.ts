/**
 * A document's edit history, replayed: history.yaml beside a corpus lists dated versions of
 * one document, and the replay writes them one at a time into a working copy of the corpus,
 * with the clock at each version's date, and ingests after each. After every step it reads
 * what governance leads with in each slot, so a run shows what a reader would have been told
 * the day that version was published (examples/gitlab-expenses).
 *
 * timeline.yaml gives what the document said, per slot: the value from a date until the next
 * entry, or null while it states none. The check compares the two after every step. Its
 * `engine` entries record, per slot, where the engine leads with something else today and
 * why, in the same shape; the history test holds the replay to them, so a change that closes
 * or opens a gap shows in a diff of that file.
 *
 * The replay also counts what each version asked of people: the todos it raised, by kind;
 * the open todos it gave more to decide (a list of statements no longer stated that grew),
 * which ask again; the todos withdrawn without a person; and the conflict cases governance
 * opened, with how many it settled without a person. With a timeline, a fact changed in a
 * version when the value in effect differs from the one before (a value that appears or
 * stops being stated counts too), so the report gives asks per changed fact. The first
 * version is the first read of the document, counted apart.
 *
 * The working copy lives in a temporary folder, so the corpus on disk stays as it is.
 */

import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { schemaErrors, slotOf, valueKeyOf } from "@inspiration/contracts";
import { parse } from "yaml";
import { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";
import { ingest } from "./ingest.ts";

export interface HistoryStep {
  /** When the version was published, as an ISO 8601 time. */
  at: string;
  /** The version's text, relative to the corpus. */
  from: string;
  commit?: string;
  url?: string;
  title?: string;
}

export interface History {
  /** Where the document lives in the corpus, relative to it. */
  document: string;
  steps: HistoryStep[];
}

export interface TimelineEntry {
  /** The day the value took effect, YYYY-MM-DD. */
  from: string;
  /** null while the document states no value. */
  value: string | null;
}

export interface Timeline {
  slots: Record<string, TimelineEntry[]>;
  /** Where the engine leads with something else today: the slot's timeline as it runs, and why. */
  engine?: Record<string, { why: string; timeline: TimelineEntry[] }>;
}

export class HistoryError extends Error {
  override name = "HistoryError";
}

const DAY = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const ENTRIES = {
  type: "array",
  items: {
    type: "object",
    required: ["from", "value"],
    additionalProperties: false,
    properties: { from: DAY, value: { type: ["string", "null"] } },
  },
};
const HISTORY_SCHEMA = {
  type: "object",
  required: ["document", "steps"],
  properties: {
    document: { type: "string", minLength: 1 },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["at", "from"],
        properties: {
          at: { type: "string", minLength: 1 },
          from: { type: "string", minLength: 1 },
          commit: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
};
const TIMELINE_SCHEMA = {
  type: "object",
  required: ["slots"],
  properties: {
    slots: { type: "object", additionalProperties: ENTRIES },
    engine: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["why", "timeline"],
        properties: { why: { type: "string", minLength: 1 }, timeline: ENTRIES },
      },
    },
  },
};

async function readYaml(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  return text === undefined ? undefined : (parse(text) as unknown);
}

/** history.yaml beside the corpus, or undefined when it has none. */
export async function loadHistory(dir: string): Promise<History | undefined> {
  const raw = await readYaml(join(dir, "history.yaml"));
  if (raw === undefined) return undefined;
  const errors = schemaErrors(HISTORY_SCHEMA, raw);
  if (errors.length) throw new HistoryError(`invalid history.yaml: ${errors.join("; ")}`);
  const history = raw as History;
  const times = history.steps.map((s) => Date.parse(s.at));
  if (times.some((t, i) => Number.isNaN(t) || (i > 0 && t < (times[i - 1] as number)))) {
    throw new HistoryError("history.yaml: steps must be dated and in order");
  }
  return history;
}

/** timeline.yaml beside the corpus, or undefined when it has none. */
export async function loadTimeline(dir: string): Promise<Timeline | undefined> {
  const raw = await readYaml(join(dir, "timeline.yaml"));
  if (raw === undefined) return undefined;
  const errors = schemaErrors(TIMELINE_SCHEMA, raw);
  if (errors.length) throw new HistoryError(`invalid timeline.yaml: ${errors.join("; ")}`);
  const timeline = raw as Timeline;
  for (const slot of Object.keys(timeline.engine ?? {})) {
    if (!timeline.slots[slot]) throw new HistoryError(`timeline.yaml: engine entry for ${slot}, which no slot has`);
  }
  return timeline;
}

/** What governance leads with in a slot after a step. */
export interface SlotState {
  /** The proposed value, or the only one; absent while values compete with no proposal. */
  leads?: string;
  /** Every value the slot holds, sorted. */
  values: string[];
  /** The document no longer states the leading value: it is kept, marked (Claim.unstated). */
  unstated?: true;
}

/** What one version asked of people. */
export interface StepAsks {
  /** Todos it raised, by kind; notes ask for no decision and are counted apart. */
  todos: Record<string, number>;
  /** Open todos that list statements they did not list at the step before, by kind. */
  more: Record<string, number>;
  /** Todos withdrawn because what they asked about went away. */
  withdrawn: number;
  notes: number;
  /** Conflict cases governance opened, and how many of them it settled without a person. */
  cases: number;
  settled: number;
}

export interface StepResult {
  at: string;
  title?: string;
  /** Slots that hold a value, by slot. */
  slots: Record<string, SlotState>;
  claims: number;
  asks: StepAsks;
}

/** Review load over the versions after the first: what people were asked per real change. */
export interface ReviewLoad {
  /** Versions after the first. */
  versions: number;
  /** Facts the timeline changes in those versions; null without a timeline. */
  changed_facts: number | null;
  todos: number;
  todos_by_kind: Record<string, number>;
  /**
   * Times an open todo was given statements to decide on that it did not list at the step
   * before, so a statement that leaves and comes back counts each time it comes back.
   */
  more: number;
  withdrawn: number;
  notes: number;
  /** Todos raised and todos given more, per changed fact; null without a timeline or a change. */
  asks_per_changed_fact: number | null;
  cases: number;
  settled: number;
  /** What the first read asked. */
  first: StepAsks;
}

export interface SlotCheck {
  slot: string;
  /** Steps whose leading value is the one in effect that day. */
  right: number;
  /** Steps that differ the way the engine entry records. */
  recorded: number;
  steps: number;
  /** Per step: what the document said, what the engine entry records, what the run led with. */
  rows: { at: string; expected: string | null; recorded: string | null; observed: string | null }[];
  why?: string;
}

export interface ReplayReport {
  steps: StepResult[];
  review: ReviewLoad;
  check?: {
    slots: SlotCheck[];
    /** Slots the run filled that timeline.yaml does not name: statements in a slot they do not belong to. */
    unexpected: string[];
    totals: { steps: number; right: number; as_recorded: number };
  };
}

/** The value in effect on a day, by a timeline. */
export function inEffect(entries: readonly TimelineEntry[], day: string): string | null {
  let value: string | null = null;
  for (const e of entries) if (e.from <= day) value = e.value;
  return value;
}

async function observe(engine: Engine, corpus: Corpus): Promise<{ slots: Record<string, SlotState>; claims: number }> {
  const tenantId = corpus.tenantId;
  const limit = 10000;
  const claims = await engine.store.asOf({ space_ids: corpus.manifest.spaces.map((s) => s.id), limit });
  if (claims.length === limit) throw new HistoryError(`more than ${limit} current claims: the replay reads one page`);
  const slots = new Set(claims.flatMap((c) => (valueKeyOf(c) !== undefined ? (slotOf(c) ?? []) : [])));
  const out: Record<string, SlotState> = {};
  for (const slot of [...slots].sort()) {
    const { groups, decision } = await engine.governance.slot(tenantId, slot);
    const values = groups.map((g) => g.value).sort();
    if (!values.length) continue;
    const leads = decision?.proposed.value ?? (values.length === 1 ? values[0] : undefined);
    const stating = claims.filter((c) => slotOf(c) === slot && valueKeyOf(c) === leads);
    const unstated = stating.length > 0 && stating.every((c) => c.unstated);
    out[slot] = { values, ...(leads !== undefined && { leads }), ...(unstated && { unstated }) };
  }
  return { slots: out, claims: claims.length };
}

function noAsks(): StepAsks {
  return { todos: {}, more: {}, withdrawn: 0, notes: 0, cases: 0, settled: 0 };
}

function add(counts: Record<string, number>, kind: string, n = 1): void {
  counts[kind] = (counts[kind] ?? 0) + n;
}

/**
 * What was asked since the last call. `seen` remembers each todo's status and the units it
 * listed at the last call, and the conflict cases.
 */
async function asked(
  engine: Engine,
  tenantId: string,
  seen: { todos: Map<string, { open: boolean; units: Set<string> }>; cases: Set<string> },
): Promise<StepAsks> {
  const asks = noAsks();
  for (const { todo } of await engine.inbox.items(tenantId)) {
    const open = todo.status === "open";
    const before = seen.todos.get(todo.id);
    seen.todos.set(todo.id, { open, units: new Set(todo.unit_ids) });
    if (!before) {
      if (todo.kind === "note") asks.notes++;
      else add(asks.todos, todo.kind);
    } else if (before.open && !open && todo.resolved_with === "withdrawn") {
      asks.withdrawn++;
    } else if (open && todo.unit_ids.some((id) => !before.units.has(id))) {
      add(asks.more, todo.kind);
    }
  }
  for (const c of await engine.governance.conflicts(tenantId)) {
    if (seen.cases.has(c.id)) continue;
    seen.cases.add(c.id);
    asks.cases++;
    if (c.status === "auto_resolved") asks.settled++;
  }
  return asks;
}

/** Facts whose value in effect differs from the version before, per version after the first. */
function changedFacts(steps: readonly StepResult[], timeline: Timeline): number {
  let n = 0;
  for (const entries of Object.values(timeline.slots)) {
    for (let i = 1; i < steps.length; i++) {
      const day = (s: StepResult | undefined) => s?.at.slice(0, 10) ?? "";
      if (inEffect(entries, day(steps[i])) !== inEffect(entries, day(steps[i - 1]))) n++;
    }
  }
  return n;
}

function review(steps: readonly StepResult[], timeline: Timeline | undefined): ReviewLoad {
  const later = steps.slice(1);
  const byKind: Record<string, number> = {};
  for (const s of later) for (const [k, n] of Object.entries(s.asks.todos)) add(byKind, k, n);
  const sum = (f: (a: StepAsks) => number) => later.reduce((n, s) => n + f(s.asks), 0);
  const todos = sum((a) => Object.values(a.todos).reduce((x, y) => x + y, 0));
  const more = sum((a) => Object.values(a.more).reduce((x, y) => x + y, 0));
  const changed = timeline ? changedFacts(steps, timeline) : null;
  return {
    versions: later.length,
    changed_facts: changed,
    todos,
    todos_by_kind: byKind,
    more,
    withdrawn: sum((a) => a.withdrawn),
    notes: sum((a) => a.notes),
    asks_per_changed_fact: changed ? Math.round(((todos + more) / changed) * 100) / 100 : null,
    cases: sum((a) => a.cases),
    settled: sum((a) => a.settled),
    first: steps[0]?.asks ?? noAsks(),
  };
}

/**
 * Replays the history of the corpus in dir against the engine, whose clock is set to each
 * step's time before it is ingested. The engine must take its clock from setNow's target.
 */
export async function replay(
  engine: Engine,
  dir: string,
  history: History,
  setNow: (at: Date) => void,
  options: { timeline?: Timeline } = {},
): Promise<ReplayReport> {
  const work = await mkdtemp(join(tmpdir(), "inspiration-history-"));
  try {
    // The versions stay where they are; the working copy only needs the corpus itself.
    const versions = join(dir, "history");
    await cp(dir, work, { recursive: true, filter: (src) => src !== versions && !src.startsWith(versions + sep) });
    const corpus = await Corpus.load(work);
    const target = join(work, history.document);
    const steps: StepResult[] = [];
    const seen = { todos: new Map<string, { open: boolean; units: Set<string> }>(), cases: new Set<string>() };
    for (const step of history.steps) {
      const at = new Date(step.at);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(dir, step.from)));
      await utimes(target, at, at);
      setNow(at);
      const run = await ingest(engine, corpus);
      if (run.dead_letters) throw new HistoryError(`step ${step.at}: ${run.dead_letters} dead letters`);
      steps.push({
        at: step.at,
        ...(step.title && { title: step.title }),
        ...(await observe(engine, corpus)),
        asks: await asked(engine, corpus.tenantId, seen),
      });
    }
    return {
      steps,
      review: review(steps, options.timeline),
      ...(options.timeline && { check: check(steps, options.timeline) }),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function check(steps: StepResult[], timeline: Timeline): NonNullable<ReplayReport["check"]> {
  const slots: SlotCheck[] = [];
  for (const [slot, entries] of Object.entries(timeline.slots)) {
    const engine = timeline.engine?.[slot];
    const rows = steps.map((s) => {
      const day = s.at.slice(0, 10);
      const expected = inEffect(entries, day);
      return {
        at: s.at,
        expected,
        recorded: engine ? inEffect(engine.timeline, day) : expected,
        observed: s.slots[slot]?.leads ?? null,
      };
    });
    slots.push({
      slot,
      right: rows.filter((r) => r.observed === r.expected).length,
      recorded: rows.filter((r) => r.observed === r.recorded).length,
      steps: rows.length,
      rows,
      ...(engine && { why: engine.why }),
    });
  }
  const named = new Set(Object.keys(timeline.slots));
  const unexpected = [...new Set(steps.flatMap((s) => Object.keys(s.slots)))].filter((s) => !named.has(s)).sort();
  const sum = (f: (c: SlotCheck) => number) => slots.reduce((n, c) => n + f(c), 0);
  return {
    slots,
    unexpected,
    totals: { steps: sum((c) => c.steps), right: sum((c) => c.right), as_recorded: sum((c) => c.recorded) },
  };
}

export function replayLines(r: ReplayReport): string[] {
  const lines = [`replay: ${r.steps.length} versions`];
  for (const s of r.steps) {
    const held = Object.entries(s.slots).map(
      ([slot, st]) => `${slot}=${st.leads ?? `[${st.values.join(" | ")}]`}${st.unstated ? " (no longer stated)" : ""}`,
    );
    const a = s.asks;
    const asks = [
      ...Object.entries(a.todos).map(([k, n]) => plural(n, `${k} todo`)),
      ...Object.entries(a.more).map(([k, n]) => `more to decide in ${plural(n, `open ${k} todo`)}`),
      ...(a.withdrawn ? [`${plural(a.withdrawn, "todo")} withdrawn`] : []),
      ...(a.notes ? [plural(a.notes, "note")] : []),
      ...(a.cases ? [`${plural(a.cases, "conflict case")}, ${a.settled} settled without a person`] : []),
    ];
    const asked = asks.length ? `; asked: ${asks.join(", ")}` : "";
    lines.push(`  ${s.at.slice(0, 10)} ${s.claims} claims; ${held.join(", ") || "no slot holds a value"}${asked}`);
  }
  const v = r.review;
  const kinds = Object.entries(v.todos_by_kind).map(([k, n]) => `${n} ${k}`);
  lines.push(
    `review: after the first read, ${plural(v.versions, "version")} changed ${v.changed_facts ?? "?"} facts and raised ${plural(v.todos, "todo")}${kinds.length ? ` (${kinds.join(", ")})` : ""}, gave open todos more to decide ${plural(v.more, "time")} and withdrew ${v.withdrawn}: ${v.asks_per_changed_fact ?? "?"} asks per changed fact; ${plural(v.notes, "note")}; ${plural(v.cases, "conflict case")}, ${v.settled} settled without a person`,
  );
  const f = Object.entries(v.first.todos).map(([k, n]) => `${n} ${k}`);
  lines.push(
    `  the first read raised ${f.join(", ") || "no todo"}, ${plural(v.first.cases, "conflict case")}, ${v.first.settled} settled without a person`,
  );
  if (!r.check) return lines;
  const t = r.check.totals;
  lines.push(`timeline: ${t.right} of ${t.steps} slot-versions as expected, ${t.as_recorded} as timeline.yaml records`);
  for (const c of r.check.slots) {
    const state = c.right === c.steps ? "right" : c.recorded === c.steps ? "known gap" : "differs";
    lines.push(`  ${state}: ${c.slot}, ${c.right} of ${c.steps} versions right`);
    // A gap usually lasts many versions; consecutive ones that differ the same way share a line.
    const runs: { from: string; to: string; n: number; observed: string | null; expected: string | null }[] = [];
    let open = false;
    for (const row of c.rows) {
      const day = row.at.slice(0, 10);
      const last = runs.at(-1);
      if (row.observed === row.expected) open = false;
      else if (open && last && last.observed === row.observed && last.expected === row.expected) {
        last.to = day;
        last.n++;
      } else {
        runs.push({ from: day, to: day, n: 1, observed: row.observed, expected: row.expected });
        open = true;
      }
    }
    for (const r of runs) {
      const when = r.n === 1 ? r.from : `${r.from} to ${r.to} (${r.n} versions)`;
      lines.push(`    ${when}: led with ${r.observed ?? "nothing"}, expected ${r.expected ?? "nothing"}`);
    }
    if (c.why && c.right !== c.steps) lines.push(`    why: ${c.why}`);
  }
  if (r.check.unexpected.length) lines.push(`  in slots timeline.yaml does not name: ${r.check.unexpected.join(", ")}`);
  return lines;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
