import type {
  GovernanceLevel,
  KnowledgeStore,
  Placement,
  SensitivityLabel,
  SourceVersion,
  TaxonomyNode,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import type { Level } from "./cluster.ts";

export const COMPONENT = "page-compiler";

/** IDs per store read or placement write batch. */
export const READ_BATCH = 500;

/** The blocks under one heading path of a document, and the current claims they state. */
export interface Section {
  key: string;
  tenant_id: string;
  space_id: string;
  /** source_id:external_id */
  document: string;
  source_version_id: string;
  title: string;
  heading_path: string[];
  level: GovernanceLevel;
  /** Its document is archived or retired: its claims are history, and are not placed. */
  archived?: true;
  sensitivity: SensitivityLabel;
  language?: string;
  /** Current claims, in reading order, with their slots. */
  claims: { id: string; slot?: string }[];
  /** Sections of current governed documents only: what the embedding was made from, and the embedding. */
  text_hash?: string;
  vector?: string;
  /** Its leaf topic, and how close it is to it. */
  topic?: string;
  score?: number;
}

/** A topic as clustering left it: where it sits, and the centroid the next run starts from. */
export interface TopicState {
  tenant_id: string;
  key: string;
  space_id: string;
  level: Level;
  parent?: string;
  /** It holds sections itself: a subtopic, or a topic without subtopics. */
  leaf: boolean;
  centroid: string;
  retired?: true;
}

/** The topic a fact slot's claims go to in a space: the one most of its statements are in. */
export interface SlotTopic {
  tenant_id: string;
  space_id: string;
  slot_key: string;
  topic: string;
}

/**
 * Store writes an update decided on, kept with the sections they follow from until the store
 * has them. The knowledge store and these records commit separately; counts are absolute,
 * so writing them again is the same as writing them once.
 */
export interface PendingWrite {
  tenant_id: string;
  document: string;
  /** Statement counts of the topics that change, by key. */
  counts: Record<string, number>;
  place: Placement[];
  unplace: string[];
}

export interface Target {
  topic: string;
  score?: number;
}

export const recordKey = (...parts: string[]) => parts.join("\x1f");

export const SECTIONS = defineTable<Section>("page_compiler.sections", {
  key: (s) => s.key,
  columns: { tenant_id: (s) => s.tenant_id, document: (s) => s.document },
});

export const TOPICS = defineTable<TopicState>("page_compiler.topics", {
  key: (t) => recordKey(t.tenant_id, t.key),
  columns: { tenant_id: (t) => t.tenant_id, space_id: (t) => t.space_id, leaf: (t) => t.leaf },
  types: { leaf: "boolean" },
});

export const SLOTS = defineTable<SlotTopic>("page_compiler.slots", {
  key: (s) => recordKey(s.tenant_id, s.space_id, s.slot_key),
  columns: { tenant_id: (s) => s.tenant_id },
});

export const PENDING = defineTable<PendingWrite>("page_compiler.pending", {
  key: (p) => recordKey(p.tenant_id, p.document),
  columns: { tenant_id: (p) => p.tenant_id },
});

export const documentOf = (v: Pick<SourceVersion, "source_id" | "external_id">) => `${v.source_id}:${v.external_id}`;

/** A unit vector as int8, scaled to its largest component, in base64. */
export function quantize(v: Float32Array): string {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(((v[i] as number) / (max || 1)) * 127);
  return Buffer.from(q.buffer).toString("base64");
}

export function dequantize(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  const v = Float32Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  return normalized(v);
}

export function normalized(v: Float32Array): Float32Array {
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Sections whose statements are clustered: those of current governed documents. */
export const clustered = (s: Section) => s.level === "governed" && !s.archived;

/** Placements clustering never moves: confirmed ones, and those a page or a person made. */
export const fixed = (p: Placement | undefined) => p !== undefined && (p.confirmed || p.placed_by !== "clustering");

/** A node without a status predates statuses and counts as confirmed. */
export const isConfirmed = (n: TaxonomyNode | undefined) =>
  n !== undefined && (n.status === undefined || n.status === "confirmed");

export const score = (x: number) => Math.max(0, Math.min(1, Math.round(x * 1000) / 1000));

export async function batched<T>(ids: readonly string[], read: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) out.push(...(await read(ids.slice(i, i + READ_BATCH))));
  return out;
}

/** JSON with every object's keys sorted, so two records compare by content. */
export const canonical = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** The map's value for the key, made and stored first when there is none. */
export function entry<K, V>(map: Map<K, V>, k: K, make: () => V): V {
  let v = map.get(k);
  if (v === undefined) {
    v = make();
    map.set(k, v);
  }
  return v;
}

export function bump(counts: Map<string, number>, k: string | undefined, by = 1): void {
  if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + by);
}

export const byCount = (counts: ReadonlyMap<string, number>) =>
  [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));

export function makePlacement(
  tenantId: string,
  spaceId: string,
  claimId: string,
  target: Target,
  at: string,
): Placement {
  return {
    tenant_id: tenantId,
    claim_id: claimId,
    space_id: spaceId,
    taxonomy_key: target.topic,
    placed_by: "clustering",
    confirmed: false,
    placed_at: at,
    ...(target.score !== undefined && { score: target.score }),
  };
}

/**
 * Finish the store writes of updates that failed after their sections committed. It runs
 * before anything else reads or changes the tenant's counts, so absolute counts stay right.
 */
export async function flushPending(store: KnowledgeStore, records: Records, tenantId: string): Promise<void> {
  for (const p of await records.find(PENDING, { tenant_id: tenantId })) await writePending(store, records, p);
}

export async function writePending(store: KnowledgeStore, records: Records, p: PendingWrite): Promise<void> {
  const counts = Object.entries(p.counts);
  const nodes = counts.length ? new Map((await store.topics(p.tenant_id)).map((n) => [n.key, n])) : new Map();
  const writes = counts.flatMap(([k, count]) => {
    const n = nodes.get(k);
    return n && n.statement_count !== count ? [{ ...n, statement_count: count }] : [];
  });
  await store.transaction(async (tx) => {
    if (writes.length) await tx.putTopics(writes);
    if (p.unplace.length) await tx.unplace(p.unplace);
    if (p.place.length) await tx.place(p.place);
  });
  await records.transaction((tx) => tx.delete(PENDING, [PENDING.key(p)]));
}
