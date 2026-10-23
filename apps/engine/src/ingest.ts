/**
 * An ingest run over a corpus, and the report the UI work sizes itself by: how many
 * documents, blocks and spans a tenant like this produces, how they split by kind, what
 * normalization could not parse, which duplicates it found, how many ACL entries the
 * directory could not map, what extraction made of it all (see claims.ts), and which
 * conflicts governance found and what they would ask of people (see conflicts.ts).
 */

import type { AclChanged, BlocksChanged, ClaimsUpdated, EventEnvelope } from "@inspiration/contracts";
import { payloadOf } from "@inspiration/contracts";
import { InMemoryTransport, ValkeyStreamsTransport } from "@inspiration/eventbus";
import type { ItemOutcome, SyncReport } from "@inspiration/source-sync";
import { type ClaimsReport, claimsReport, type Spread, spread, type Truth, usageMark } from "./claims.ts";
import { type GovernanceReport, governanceReport } from "./conflicts.ts";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";

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
    by_governance: Record<string, number>;
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
    return tally;
  }

  private constructor(engine: Engine) {
    const count = (fn?: (e: EventEnvelope) => void) => async (e: EventEnvelope) => {
      bump(this.events, e.type);
      fn?.(e);
    };
    engine.observe("document.fetched", REPORT_GROUP, count());
    engine.observe(
      "blocks.changed",
      REPORT_GROUP,
      count((e) => this.changes.push(payloadOf(e, "blocks.changed"))),
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
      count((e) => this.requests.push(e)),
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
  const before = { ...engine.extraction.totals };
  const started = performance.now();
  const runs: { source: (typeof corpus.sources)[number]; report: SyncReport }[] = [];
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
        windows: engine.extraction.totals.windows - before.windows,
        failed_windows: engine.extraction.totals.failed_windows - before.failed_windows,
        rejected: engine.extraction.totals.rejected - before.rejected,
      },
      usageFrom,
      ...(options.truth && { truth: options.truth }),
    }),
    governance: await governanceReport(engine, corpus.tenantId, {
      requests: tally.requests,
      updates: tally.updateEvents,
      ...(options.truth && { truth: options.truth }),
    }),
    dead_letters: await deadLetters(engine),
  };
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
    by_governance: {},
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
        const governance = version.metadata?.extra?.governance;
        bump(documents.by_governance, typeof governance === "string" ? governance : "unset");
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

/** The report as a short plain-text summary for a terminal. */
export function summary(r: IngestReport): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  const lines = [
    `tenant ${r.tenant}: sync ${r.seconds.sync}s, normalization, extraction and governance ${r.seconds.settle}s`,
    ...r.sources.map(
      (s) =>
        `  ${s.name} (${s.type}): ${s.items} items, ${kv(r.sources.find((x) => x.id === s.id)?.outcomes ?? {})}` +
        (s.errors.length ? `, ${s.errors.length} errors` : ""),
    ),
    `documents ${r.documents.total}: ${kv(r.documents.by_status)}`,
    `  governance: ${kv(r.documents.by_governance)}`,
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
    `events: ${kv(r.events)}; dead letters ${r.dead_letters}`,
  ];
  return lines.join("\n");
}

function governanceLines(g: GovernanceReport, kv: (o: Record<string, number>) => string): string[] {
  const t = g.truth;
  return [
    `conflict cases ${g.cases.total}: ${kv(g.cases.by_class)}; ${kv(g.cases.by_status)}`,
    `  todos ${g.todos} (${kv(g.todos_by_priority) || "none"}), values per todo median ${g.values_per_todo.median}, max ${g.values_per_todo.max}; proposed by ${kv(g.proposed_by) || "none"}`,
    `  todo requests ${g.requests} from ${g.updates_with_requests} of ${g.updates} claims updates (per update max ${g.requests_per_update.max})`,
    ...(t
      ? [
          `  truth: proposed the expected value for ${t.expected} of ${t.slots} facts (${t.ambiguous} with tied decisions)`,
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
    `claims ${c.added} (per document median ${c.per_document.median}, p90 ${c.per_document.p90}, max ${c.per_document.max}); closed ${c.closed}; ${c.windows} windows, ${c.failed_windows} failed, ${c.rejected} claims rejected`,
    ...Object.entries(c.by_governance)
      .sort(([, a], [, b]) => b.claims - a.claims)
      .map(
        ([k, g]) =>
          `  ${k}: ${g.claims} claims in ${g.documents} documents (median ${g.per_document.median}, p90 ${g.per_document.p90})`,
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
        ]
      : []),
  ];
}
