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
}

export interface StepResult {
  at: string;
  title?: string;
  /** Slots that hold a value, by slot. */
  slots: Record<string, SlotState>;
  claims: number;
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
  // One document's claims fit in one page.
  const claims = await engine.store.asOf({ space_ids: corpus.manifest.spaces.map((s) => s.id) });
  const slots = new Set(claims.flatMap((c) => (valueKeyOf(c) !== undefined ? (slotOf(c) ?? []) : [])));
  const out: Record<string, SlotState> = {};
  for (const slot of [...slots].sort()) {
    const { groups, decision } = await engine.governance.slot(tenantId, slot);
    const values = groups.map((g) => g.value).sort();
    if (!values.length) continue;
    const leads = decision?.proposed.value ?? (values.length === 1 ? values[0] : undefined);
    out[slot] = { values, ...(leads !== undefined && { leads }) };
  }
  return { slots: out, claims: claims.length };
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
    for (const step of history.steps) {
      const at = new Date(step.at);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(dir, step.from)));
      await utimes(target, at, at);
      setNow(at);
      const run = await ingest(engine, corpus);
      if (run.dead_letters) throw new HistoryError(`step ${step.at}: ${run.dead_letters} dead letters`);
      steps.push({ at: step.at, ...(step.title && { title: step.title }), ...(await observe(engine, corpus)) });
    }
    return { steps, ...(options.timeline && { check: check(steps, options.timeline) }) };
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
    const held = Object.entries(s.slots).map(([slot, st]) => `${slot}=${st.leads ?? `[${st.values.join(" | ")}]`}`);
    lines.push(`  ${s.at.slice(0, 10)} ${s.claims} claims; ${held.join(", ") || "no slot holds a value"}`);
  }
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
