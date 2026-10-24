/**
 * An ingest run over a corpus, and the report the UI work sizes itself by: how many
 * documents, blocks and spans a tenant like this produces, how they split by kind, what
 * normalization could not parse, which duplicates it found and how many ACL entries the
 * directory could not map.
 */

import type { AclChanged, BlocksChanged, EventEnvelope } from "@inspiration/contracts";
import { payloadOf } from "@inspiration/contracts";
import { InMemoryTransport, ValkeyStreamsTransport } from "@inspiration/eventbus";
import type { ItemOutcome, SyncReport } from "@inspiration/source-sync";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";

const REPORT_GROUP = "engine-report";

export interface Spread {
  median: number;
  p90: number;
  max: number;
}

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
  dead_letters: number;
}

function spread(values: readonly number[]): Spread {
  if (!values.length) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { median: at(0.5), p90: at(0.9), max: sorted.at(-1) as number };
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** Tallies the events of a run as they are delivered, under its own consumer group. */
class EventTally {
  events: Record<string, number> = {};
  changes: BlocksChanged[] = [];
  acl: AclChanged[] = [];

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
  }
}

/** Register the corpus's sources, sync each once, deliver every event, and report. */
export async function ingest(engine: Engine, corpus: Corpus): Promise<IngestReport> {
  const tally = EventTally.for(engine);
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
    `tenant ${r.tenant}: sync ${r.seconds.sync}s, normalization ${r.seconds.settle}s`,
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
    `events: ${kv(r.events)}; dead letters ${r.dead_letters}`,
  ];
  return lines.join("\n");
}
