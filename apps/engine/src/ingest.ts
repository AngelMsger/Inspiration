/**
 * An ingest run over a corpus, and the report the UI work sizes itself by: how many
 * documents, blocks and spans a tenant like this produces, how they split by kind, what
 * normalization could not parse, which duplicates it found, how many ACL entries the
 * directory could not map, what extraction made of it all (see claims.ts), which conflicts
 * governance found and what they would ask of people (see conflicts.ts), which reviews
 * freshness scheduled or asked for (see freshness.ts), the knowledge outline page-compiler
 * clustered (see outline.ts), who owns its topics (see owners.ts), what the inbox holds for
 * them (see inbox.ts), and what each source update asked of people at once, todo requests
 * and reviews together.
 */

import type { AclChanged, BlocksChanged, ClaimsUpdated, EventEnvelope, GovernanceLevel } from "@inspiration/contracts";
import { levelOf, payloadOf } from "@inspiration/contracts";
import { InMemoryTransport, ValkeyStreamsTransport } from "@inspiration/eventbus";
import type { ItemOutcome, SyncReport } from "@inspiration/source-sync";
import { type ClaimsReport, claimsReport, type Spread, spread, type Truth, usageMark } from "./claims.ts";
import { type GovernanceReport, governanceReport } from "./conflicts.ts";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";
import { type DaysReport, type FreshnessReport, freshnessReport } from "./freshness.ts";
import { type InboxReport, inboxLines, inboxReport } from "./inbox.ts";
import { type OutlineReport, outlineLines, outlineReport } from "./outline.ts";
import { assignOwners, type OwnersReport, ownersLines } from "./owners.ts";

export type { Spread } from "./claims.ts";

const REPORT_GROUP = "engine-report";

export interface IngestReport {
  tenant: string;
  seconds: { sync: number; settle: number };
  sources: {
    id: string;
    name: string;
    type: string;
    items: number;
    deleted: number;
    outcomes: Record<ItemOutcome, number>;
    errors: SyncReport["errors"];
  }[];
  documents: {
    total: number;
    by_status: Record<string, number>;
    by_parser: Record<string, number>;
    by_mime_type: Record<string, number>;
    by_level: Record<string, number>;
  };
  blocks: { total: number; by_kind: Record<string, number>; per_document: Spread };
  spans: { total: number; by_kind: Record<string, number>; per_document: Spread; characters: Spread };
  events: Record<string, number>;
  /** Paths in the corpus. */
  duplicates: { document: string; duplicate_of: string; exact: boolean; similarity: number }[];
  /** Against truth.json, when the corpus has one (synthesized corpora do). */
  planted?: { duplicates: number; found: number; unexpected: number };
  acl: { changes: number; entries: number; mapped: number; unmapped: string[] };
  claims: ClaimsReport;
  governance: GovernanceReport;
  freshness: FreshnessReport;
  outline: OutlineReport;
  owners: OwnersReport;
  inbox: InboxReport;
  /**
   * New versions of documents already known, and the todo requests and reviews each asked for
   * at once. Every event a source update causes shares its correlation id.
   */
  asks: { updates: number; asking: number; per_update: Spread };
  dead_letters: number;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** Tallies the events of a run as they are delivered, under its own consumer group. */
class EventTally {
  events: Record<string, number> = {};
  changes: BlocksChanged[] = [];
  acl: AclChanged[] = [];
  updates: ClaimsUpdated[] = [];
  updateEvents: EventEnvelope[] = [];
  requests: EventEnvelope[] = [];
  notes: EventEnvelope[] = [];
  withdrawn: EventEnvelope[] = [];
  changeEvents: EventEnvelope[] = [];
  reviews: EventEnvelope[] = [];
  fetched: EventEnvelope[] = [];

  static #byEngine = new WeakMap<Engine, EventTally>();

  /** The engine's tally, emptied for a new run; its handlers are subscribed once. */
  static for(engine: Engine): EventTally {
    let tally = EventTally.#byEngine.get(engine);
    if (!tally) {
      tally = new EventTally(engine);
      EventTally.#byEngine.set(engine, tally);
    }
    tally.events = {};
    tally.changes = [];
    tally.acl = [];
    tally.updates = [];
    tally.updateEvents = [];
    tally.requests = [];
    tally.notes = [];
    tally.withdrawn = [];
    tally.changeEvents = [];
    tally.reviews = [];
    tally.fetched = [];
    return tally;
  }

  private constructor(engine: Engine) {
    const count = (fn?: (e: EventEnvelope) => void) => async (e: EventEnvelope) => {
      bump(this.events, e.type);
      fn?.(e);
    };
    engine.observe(
      "document.fetched",
      REPORT_GROUP,
      count((e) => this.fetched.push(e)),
    );
    engine.observe(
      "blocks.changed",
      REPORT_GROUP,
      count((e) => {
        this.changes.push(payloadOf(e, "blocks.changed"));
        this.changeEvents.push(e);
      }),
    );
    engine.observe(
      "acl.changed",
      REPORT_GROUP,
      count((e) => this.acl.push(payloadOf(e, "acl.changed"))),
    );
    engine.observe(
      "claims.updated",
      REPORT_GROUP,
      count((e) => {
        this.updates.push(payloadOf(e, "claims.updated"));
        this.updateEvents.push(e);
      }),
    );
    engine.observe(
      "todo.requested",
      REPORT_GROUP,
      count((e) => {
        const r = payloadOf(e, "todo.requested");
        (r.withdrawn ? this.withdrawn : r.kind === "note" ? this.notes : this.requests).push(e);
      }),
    );
    engine.observe(
      "review.due",
      REPORT_GROUP,
      count((e) => this.reviews.push(e)),
    );
  }
}

/**
 * Register the corpus's sources, sync each once, deliver every event, and report. With the
 * corpus's truth.json, the report checks extracted facts against it.
 */
export async function ingest(engine: Engine, corpus: Corpus, options: { truth?: Truth } = {}): Promise<IngestReport> {
  const tally = EventTally.for(engine);
  const usageFrom = usageMark(engine);
  const totals = engine.extraction.totals;
  const before = { ...totals, windows_by_level: { ...totals.windows_by_level } };
  const started = performance.now();
  const runs: { source: (typeof corpus.sources)[number]; report: SyncReport }[] = [];
  await corpus.provision(engine.authz);
  for (const source of corpus.sources) {
    await engine.sync.addSource(source);
    runs.push({ source, report: await engine.sync.sync(source.id, { via: "reconcile" }) });
  }
  const synced = performance.now();
  await engine.settle();
  const settled = performance.now();
  return {
    tenant: corpus.tenantId,
    seconds: { sync: round((synced - started) / 1000), settle: round((settled - synced) / 1000) },
    ...(await measure(engine, corpus, runs)),
    events: tally.events,
    duplicates: await duplicates(engine, corpus, tally.changes),
    acl: aclSummary(tally.acl),
    claims: await claimsReport(engine, corpus, {
      changes: tally.changes,
      updates: tally.updates,
      totals: {
        windows: totals.windows - before.windows,
        failed_windows: totals.failed_windows - before.failed_windows,
        rejected: totals.rejected - before.rejected,
        unused: totals.unused - before.unused,
        windows_by_level: {
          governed: totals.windows_by_level.governed - before.windows_by_level.governed,
          reference: totals.windows_by_level.reference - before.windows_by_level.reference,
          search_only: totals.windows_by_level.search_only - before.windows_by_level.search_only,
        },
      },
      usageFrom,
      ...(options.truth && { truth: options.truth }),
    }),
    governance: await governanceReport(engine, corpus.tenantId, {
      requests: tally.requests,
      notes: tally.notes.length,
      withdrawn: tally.withdrawn.length,
      updates: tally.updateEvents,
      ...(options.truth && { truth: options.truth, levels: await levelsOf(engine, corpus, tally.changes) }),
    }),
    freshness: await freshnessReport(engine, corpus.tenantId, { reviews: tally.reviews, changes: tally.changeEvents }),
    outline: await outlineReport(engine, corpus.tenantId),
    owners: await assignOwners(engine, corpus),
    inbox: await inboxReport(engine, corpus.tenantId),
    asks: asksOf(tally.fetched, [...tally.requests, ...tally.reviews]),
    dead_letters: await deadLetters(engine),
  };
}

/** The governance level of each document the run changed, by its path in the corpus. */
async function levelsOf(
  engine: Engine,
  corpus: Corpus,
  changes: readonly BlocksChanged[],
): Promise<Map<string, GovernanceLevel>> {
  const levels = new Map<string, GovernanceLevel>();
  for (const change of changes) {
    const version = await engine.store.getSourceVersion(change.source_version_id);
    if (version) levels.set(corpus.pathOf(version.source_id, version.external_id), levelOf(version));
  }
  return levels;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function measure(
  engine: Engine,
  corpus: Corpus,
  runs: { source: (typeof corpus.sources)[number]; report: SyncReport }[],
): Promise<Pick<IngestReport, "sources" | "documents" | "blocks" | "spans">> {
  const sources: IngestReport["sources"] = [];
  const documents: IngestReport["documents"] = {
    total: 0,
    by_status: {},
    by_parser: {},
    by_mime_type: {},
    by_level: {},
  };
  const blockKinds: Record<string, number> = {};
  const spanKinds: Record<string, number> = {};
  const blocksPerDoc: number[] = [];
  const spansPerDoc: number[] = [];
  const spanChars: number[] = [];
  for (const { source, report } of runs) {
    const items = await engine.sync.items(source.id);
    sources.push({
      id: source.id,
      name: source.name,
      type: source.type,
      items: items.filter((i) => !i.deleted).length,
      deleted: items.filter((i) => i.deleted).length,
      outcomes: report.outcomes,
      errors: report.errors,
    });
    for (const doc of await engine.normalization.documents(source.id)) {
      if (doc.status === "deleted") continue;
      documents.total++;
      bump(documents.by_status, doc.status);
      if (doc.parser) bump(documents.by_parser, doc.parser.name);
      const version = await engine.store.getSourceVersion(doc.source_version_id);
      if (version) {
        bump(documents.by_mime_type, version.mime_type);
        bump(documents.by_level, levelOf(version));
      }
      const blocks = await engine.store.blocksOf(doc.source_version_id);
      const spans = await engine.store.spansOf(doc.source_version_id);
      for (const b of blocks) bump(blockKinds, b.kind);
      for (const s of spans) {
        bump(spanKinds, s.locator.kind);
        spanChars.push([...s.text].length);
      }
      blocksPerDoc.push(blocks.length);
      spansPerDoc.push(spans.length);
    }
  }
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    sources,
    documents,
    blocks: { total: sum(blocksPerDoc), by_kind: blockKinds, per_document: spread(blocksPerDoc) },
    spans: {
      total: sum(spansPerDoc),
      by_kind: spanKinds,
      per_document: spread(spansPerDoc),
      characters: spread(spanChars),
    },
  };
}

async function duplicates(
  engine: Engine,
  corpus: Corpus,
  changes: readonly BlocksChanged[],
): Promise<IngestReport["duplicates"]> {
  const name = async (versionId: string) => {
    const v = await engine.store.getSourceVersion(versionId);
    return v ? corpus.pathOf(v.source_id, v.external_id) : versionId;
  };
  const out: IngestReport["duplicates"] = [];
  for (const c of changes) {
    for (const d of c.duplicates ?? []) {
      out.push({
        document: await name(c.source_version_id),
        duplicate_of: corpus.pathOf(d.source_id, d.external_id),
        exact: d.exact,
        similarity: d.similarity,
      });
    }
  }
  return out;
}

function aclSummary(changes: readonly AclChanged[]): IngestReport["acl"] {
  let entries = 0;
  let mapped = 0;
  const unmapped = new Set<string>();
  for (const c of changes) {
    for (const e of c.snapshot?.entries ?? []) {
      entries++;
      if (e.principal_id) mapped++;
      else if (e.external_id) unmapped.add(`${e.principal_kind}:${e.external_id}`);
    }
  }
  return { changes: changes.length, entries, mapped, unmapped: [...unmapped].sort() };
}

async function deadLetters(engine: Engine): Promise<number> {
  const t = engine.transport;
  let n = 0;
  for (const group of engine.consumer.groups()) {
    if (t instanceof InMemoryTransport) n += t.dlq.get(group)?.length ?? 0;
    else if (t instanceof ValkeyStreamsTransport) n += (await t.deadLetters(group)).length;
  }
  return n;
}

/**
 * How many planted duplicate pairs the run found, and how many pairs it reported that were
 * not planted. Copies of one original are duplicates of each other too, so the planted
 * pairs are closed over shared originals.
 */
export function plantedDuplicates(
  reported: IngestReport["duplicates"],
  planted: readonly { document: string; of: string }[],
): NonNullable<IngestReport["planted"]> {
  const key = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
  const family = new Map<string, Set<string>>();
  for (const p of planted) {
    const set = family.get(p.of) ?? new Set([p.of]);
    set.add(p.document);
    family.set(p.of, set);
  }
  const expected = new Set<string>();
  for (const members of family.values()) {
    const list = [...members];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) expected.add(key(list[i] as string, list[j] as string));
    }
  }
  const found = new Set(reported.map((d) => key(d.document, d.duplicate_of)));
  return {
    duplicates: expected.size,
    found: [...expected].filter((k) => found.has(k)).length,
    unexpected: [...found].filter((k) => !expected.has(k)).length,
  };
}

function asksOf(fetched: readonly EventEnvelope[], asks: readonly EventEnvelope[]): IngestReport["asks"] {
  const perUpdate = new Map<string, number>();
  for (const e of asks)
    if (e.correlation_id) perUpdate.set(e.correlation_id, (perUpdate.get(e.correlation_id) ?? 0) + 1);
  const updates = fetched.filter((e) => payloadOf(e, "document.fetched").previous_version_id);
  return {
    updates: updates.length,
    asking: updates.filter((e) => perUpdate.has(e.id)).length,
    per_update: spread(updates.map((e) => perUpdate.get(e.id) ?? 0)),
  };
}

/** The report as a short plain-text summary for a terminal. */
export function summary(r: IngestReport): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  const lines = [
    `tenant ${r.tenant}: sync ${r.seconds.sync}s, normalization, extraction, governance and freshness ${r.seconds.settle}s`,
    ...r.sources.map(
      (s) =>
        `  ${s.name} (${s.type}): ${s.items} items, ${kv(r.sources.find((x) => x.id === s.id)?.outcomes ?? {})}` +
        (s.errors.length ? `, ${s.errors.length} errors` : ""),
    ),
    `documents ${r.documents.total}: ${kv(r.documents.by_status)}`,
    `  levels: ${kv(r.documents.by_level)}`,
    `  parsers: ${kv(r.documents.by_parser)}`,
    `blocks ${r.blocks.total} (per document median ${r.blocks.per_document.median}, p90 ${r.blocks.per_document.p90}, max ${r.blocks.per_document.max}): ${kv(r.blocks.by_kind)}`,
    `spans ${r.spans.total} (per document median ${r.spans.per_document.median}, max ${r.spans.per_document.max}; characters median ${r.spans.characters.median}, p90 ${r.spans.characters.p90}): ${kv(r.spans.by_kind)}`,
    `duplicates ${r.duplicates.length}${r.planted ? ` (planted pairs found ${r.planted.found} of ${r.planted.duplicates}, ${r.planted.unexpected} not planted)` : ""}:`,
    ...r.duplicates
      .slice(0, 20)
      .map((d) => `  ${d.document} ≈ ${d.duplicate_of} (${d.exact ? "exact" : `similarity ${d.similarity}`})`),
    ...(r.duplicates.length > 20 ? [`  ... ${r.duplicates.length - 20} more`] : []),
    `acl: ${r.acl.changes} changes, ${r.acl.entries} entries, ${r.acl.mapped} mapped; unmapped ${r.acl.unmapped.join(", ") || "none"}`,
    ...claimLines(r.claims, kv),
    ...governanceLines(r.governance, kv),
    ...freshnessLines(r.freshness, kv),
    ...outlineLines(r.outline),
    ...ownersLines(r.owners),
    ...inboxLines(r.inbox),
    ...(r.asks.updates
      ? [
          `source updates ${r.asks.updates}: ${r.asks.asking} asked people for anything at once, todo requests and reviews together (per update max ${r.asks.per_update.max})`,
        ]
      : []),
    `events: ${kv(r.events)}; dead letters ${r.dead_letters}`,
  ];
  return lines.join("\n");
}

function freshnessLines(f: FreshnessReport, kv: (o: Record<string, number>) => string): string[] {
  const n = f.never_due;
  return [
    `freshness: ${f.documents} documents; review clocks by class ${kv(f.by_review_class) || "none"}; never due: ${n.dated} dated, ${n.archived} archived, ${n.no_interval} without an interval`,
    `  next review in days median ${f.review_in_days.median}, p90 ${f.review_in_days.p90}; ${f.overdue} overdue; ${f.plans_ahead.days} plan days ahead in ${f.plans_ahead.documents} documents`,
    `  states: ${kv(f.states) || "none"}; reviews published ${kv(f.reviews) || "none"}`,
    ...(f.edits
      ? [`  edits ${f.edits}, ${f.edits_with_reviews} with reviews at once (per edit max ${f.reviews_per_edit.max})`]
      : []),
  ];
}

/** The daily ticks after a run, as a short summary. */
export function daysSummary(d: DaysReport): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  return [
    `days ${d.from} to ${d.to}: backlog on the first day ${kv(d.backlog) || "none"}; ${d.campaign} marked for a first-review campaign`,
    `  reviews after it ${kv(d.reviews) || "none"}; per day median ${d.per_day.median}, p90 ${d.per_day.p90}, max ${d.per_day.max} (${d.busiest.day}); per week median ${d.per_week.median}, max ${d.per_week.max}`,
    `  governance decided ${d.rechecked_slots} slots again as dated changes took effect, ${d.recheck_requests} todo requests`,
    `  states on the last day: ${kv(d.states_at_end) || "none"}`,
  ].join("\n");
}

function governanceLines(g: GovernanceReport, kv: (o: Record<string, number>) => string): string[] {
  const t = g.truth;
  return [
    `conflict cases ${g.cases.total}: ${kv(g.cases.by_class)}; ${kv(g.cases.by_status)}`,
    `  todos ${g.todos} (${kv(g.todos_by_priority) || "none"}), values per todo median ${g.values_per_todo.median}, max ${g.values_per_todo.max}; proposed by ${kv(g.proposed_by) || "none"}`,
    `  todo requests ${g.requests} from ${g.updates_with_requests} of ${g.updates} claims updates (per update max ${g.requests_per_update.max}); notes ${g.notes}; withdrawn ${g.withdrawn}`,
    ...(t
      ? [
          `  truth: proposed the expected value for ${t.expected} of ${t.slots} facts (${t.ambiguous} with tied decisions; ${t.notes} with a later decision only reference documents record, a note)`,
          ...t.mismatches
            .slice(0, 5)
            .map((m) => `    ${m.slot}: proposed ${m.proposed}, expected ${m.expected.join(" or ")}`),
        ]
      : []),
  ];
}

function claimLines(c: ClaimsReport, kv: (o: Record<string, number>) => string): string[] {
  const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "0%");
  const m = c.models;
  return [
    `claims ${c.added} (per document median ${c.per_document.median}, p90 ${c.per_document.p90}, max ${c.per_document.max}); closed ${c.closed}; ${c.windows} windows, ${c.failed_windows} failed, ${c.rejected} claims rejected, ${c.unused} left unused`,
    ...Object.entries(c.by_level)
      .sort(([, a], [, b]) => b.claims - a.claims)
      .map(
        ([k, g]) =>
          `  ${k}: ${g.claims} claims in ${g.documents} documents (median ${g.per_document.median}, p90 ${g.per_document.p90}), ${g.windows} model calls`,
      ),
    `  types: ${kv(c.by_type)}`,
    `  in a slot ${c.in_slot} (${pct(c.in_slot, c.added)}), with a value ${c.with_value}, ${c.slots} slots; after merging about ${c.after_merging}`,
    `  slots with conflicting values ${c.conflicts.slots} (${c.conflicts.claims} claims)${c.conflicts.top.length ? ":" : ""}`,
    ...c.conflicts.top.slice(0, 5).map((t) => `    ${t.slot}: ${kv(t.values)}`),
    `  model calls ${m.calls} (${m.cached} cached): ${m.input_tokens} input and ${m.output_tokens} output tokens, cost ${m.cost}; ${kv(m.by_route)}`,
    ...(c.truth
      ? [
          `  truth: ${c.truth.found} of ${c.truth.statements} fact statements found with their value (${pct(c.truth.found, c.truth.statements)}), ${c.truth.wrong_value} with another value, ${c.truth.missed} missed`,
          `    by stance: ${Object.entries(c.truth.by_stance)
            .map(([k, v]) => `${k} ${v.found}/${v.statements}`)
            .join(", ")}`,
          `    by level: ${Object.entries(c.truth.by_level)
            .map(([k, v]) => `${k} ${v.found}/${v.statements}`)
            .join(", ")}`,
        ]
      : []),
  ];
}
