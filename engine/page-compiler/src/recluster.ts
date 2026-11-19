import type { GovernanceLevel, KnowledgeStore, ModelGateway, Placement, TaxonomyNode } from "@inspiration/contracts";
import type { Records } from "@inspiration/eventbus";
import { logger } from "@inspiration/kernel";
import type { PromptRegistry } from "@inspiration/model-gateway";
import { type Anchor, type Clustering, type ClusterOptions, cluster, dot, type Topic } from "./cluster.ts";
import { nameNewTopics } from "./naming.ts";
import type { NamedTopic } from "./protocol.ts";
import {
  batched,
  bump,
  byCount,
  canonical,
  clustered,
  dequantize,
  entry,
  fixed,
  flushPending,
  isConfirmed,
  makePlacement,
  quantize,
  READ_BATCH,
  SECTIONS,
  type Section,
  SLOTS,
  type SlotTopic,
  score,
  type Target,
  TOPICS,
  type TopicState,
} from "./records.ts";

const log = logger("page-compiler");

/** What one re-clustering of a tenant did. */
export interface ReclusterReport {
  tenant_id: string;
  /** Governed sections clustered, and their statements. */
  sections: number;
  statements: number;
  topics: {
    live: number;
    by_level: Record<"1" | "2" | "3", number>;
    created: number;
    retired: number;
    confirmed: number;
  };
  /** Current statements with a topic, by their document's level. */
  placed: Record<GovernanceLevel, number>;
  /** Statements of current governed documents without a topic (unfiled). */
  unfiled: number;
  /**
   * Statements clustering had placed before the run: those now in another topic or none,
   * and those the change budget kept where they were.
   */
  churn: { before: number; moved: number; deferred: number };
  /**
   * Statements per leaf topic, and per topic (subtopics included) with its distinct fact
   * slots and its distinct statements (a slot counted once).
   */
  sizes: { leaves: number[]; topics: number[]; topic_slots: number[]; topic_distinct: number[] };
  /** Topics named, and the model calls that named them. */
  named: number;
  model_calls: number;
}

export interface ReclusterDeps {
  store: KnowledgeStore;
  records: Records;
  models: ModelGateway;
  prompts: PromptRegistry;
  clock: () => Date;
  options: ClusterOptions;
}

function emptyReport(tenantId: string): ReclusterReport {
  return {
    tenant_id: tenantId,
    sections: 0,
    statements: 0,
    topics: { live: 0, by_level: { "1": 0, "2": 0, "3": 0 }, created: 0, retired: 0, confirmed: 0 },
    placed: { governed: 0, reference: 0, search_only: 0 },
    unfiled: 0,
    churn: { before: 0, moved: 0, deferred: 0 },
    sizes: { leaves: [], topics: [], topic_slots: [], topic_distinct: [] },
    named: 0,
    model_calls: 0,
  };
}

/**
 * Topics an owner confirmed or that hold a confirmed placement are kept, and so are the
 * topics above them.
 */
function buildAnchors(
  space: string,
  spaceStates: readonly TopicState[],
  nodes: ReadonlyMap<string, TaxonomyNode>,
  placed: ReadonlyMap<string, Placement>,
): Anchor[] {
  const kept = new Set(spaceStates.filter((t) => isConfirmed(nodes.get(t.key))).map((t) => t.key));
  for (const p of placed.values()) if (fixed(p) && p.space_id === space) kept.add(p.taxonomy_key);
  const parentOf = new Map(spaceStates.map((t) => [t.key, t.parent]));
  for (const k of [...kept]) for (let p = parentOf.get(k); p; p = parentOf.get(p)) kept.add(p);
  return spaceStates
    .filter((t) => !t.retired)
    .map((t) => ({
      key: t.key,
      level: t.level,
      ...(t.parent && { parent: t.parent }),
      centroid: dequantize(t.centroid),
      ...(kept.has(t.key) && { confirmed: true }),
    }));
}

/** Each statement goes with its section, and a slot's statements to the topic most of them are in. */
function collectSlotVotes(
  inSpace: readonly Section[],
  result: Clustering,
  placed: ReadonlyMap<string, Placement>,
  topicOf: Map<string, { topic: string; score: number } | undefined>,
  desired: Map<string, Target>,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const s of inSpace.filter(clustered)) {
    const at = result.placed.get(s.key);
    topicOf.set(s.key, at);
    for (const c of s.claims) {
      const p = placed.get(c.id);
      const topic = fixed(p) ? p?.taxonomy_key : at?.topic;
      if (!fixed(p) && at) desired.set(c.id, at);
      if (c.slot && topic) {
        bump(
          entry(votes, c.slot, () => new Map<string, number>()),
          topic,
        );
      }
    }
  }
  return new Map([...votes].map(([slot, v]) => [slot, (byCount(v)[0] as [string, number])[0]]));
}

function applySlotOverrides(
  inSpace: readonly Section[],
  slotTopic: ReadonlyMap<string, string>,
  vectors: ReadonlyMap<string, Float32Array>,
  centroids: ReadonlyMap<string, Float32Array>,
  placed: ReadonlyMap<string, Placement>,
  desired: Map<string, Target>,
): void {
  for (const s of inSpace) {
    if (s.archived) continue;
    const vector = vectors.get(s.key);
    for (const c of s.claims) {
      const topic = c.slot ? slotTopic.get(c.slot) : undefined;
      if (!topic || fixed(placed.get(c.id)) || desired.get(c.id)?.topic === topic) continue;
      const centroid = centroids.get(topic);
      desired.set(c.id, { topic, ...(vector && centroid && { score: score(dot(vector, centroid)) }) });
    }
  }
}

interface SpaceClusterAccum {
  live: Topic[];
  retired: string[];
  spaceOf: Map<string, string>;
  topicOf: Map<string, { topic: string; score: number } | undefined>;
  desired: Map<string, Target>;
  slotRows: SlotTopic[];
  reserved: string[];
  report: ReclusterReport;
}

function clusterSpace(
  tenantId: string,
  space: string,
  inSpace: readonly Section[],
  spaceStates: readonly TopicState[],
  nodes: ReadonlyMap<string, TaxonomyNode>,
  placed: ReadonlyMap<string, Placement>,
  options: ClusterOptions,
  acc: SpaceClusterAccum,
): void {
  const units = inSpace
    .filter((s) => clustered(s) && s.vector)
    .map((s) => ({
      key: s.key,
      vector: dequantize(s.vector as string),
      statements: s.claims.length,
      document: s.document,
      ...(s.topic && { previous: s.topic }),
    }));
  const anchors = buildAnchors(space, spaceStates, nodes, placed);
  const result = cluster(space, units, anchors, options, acc.reserved);
  acc.reserved.push(...result.topics.map((t) => t.key));
  acc.live.push(...result.topics);
  acc.retired.push(...result.retired);
  for (const t of result.topics) acc.spaceOf.set(t.key, space);
  acc.report.sections += units.length;
  acc.report.statements += units.reduce((n, u) => n + u.statements, 0);
  acc.report.churn.deferred += result.deferred;

  const slotTopic = collectSlotVotes(inSpace, result, placed, acc.topicOf, acc.desired);
  for (const [slot, topic] of slotTopic) {
    acc.slotRows.push({ tenant_id: tenantId, space_id: space, slot_key: slot, topic });
  }
  const centroids = new Map(result.topics.map((t) => [t.key, t.centroid]));
  const vectors = new Map(units.map((u) => [u.key, u.vector]));
  applySlotOverrides(inSpace, slotTopic, vectors, centroids, placed, acc.desired);
}

/** Statement counts, from where every current statement ends up, rolled up the tree. */
function countStatements(
  sections: readonly Section[],
  placed: ReadonlyMap<string, Placement>,
  desired: ReadonlyMap<string, Target>,
  nodes: ReadonlyMap<string, TaxonomyNode>,
  live: readonly Topic[],
  report: ReclusterReport,
) {
  const own = new Map<string, number>();
  const unitSlots = new Map<string, Set<string>>();
  const loose = new Map<string, number>();
  for (const s of sections) {
    for (const c of s.claims) {
      const p = placed.get(c.id);
      const topic = fixed(p) ? p?.taxonomy_key : desired.get(c.id)?.topic;
      if (topic) {
        bump(own, topic);
        report.placed[s.level]++;
        if (c.slot) entry(unitSlots, topic, () => new Set<string>()).add(c.slot);
        else bump(loose, topic);
      } else if (clustered(s)) report.unfiled++;
    }
  }
  const parentOf = new Map<string, string | undefined>([...nodes.values()].map((n) => [n.key, n.parent_key]));
  for (const t of live) parentOf.set(t.key, t.parent);
  const total = new Map<string, number>();
  const looseBelow = new Map<string, number>();
  const slotsBelow = new Map<string, Set<string>>();
  for (const [k, n] of own) {
    for (let at: string | undefined = k; at; at = parentOf.get(at)) {
      bump(total, at, n);
      bump(looseBelow, at, loose.get(k) ?? 0);
      const set = entry(slotsBelow, at, () => new Set<string>());
      for (const slot of unitSlots.get(k) ?? []) set.add(slot);
    }
  }
  return { total, looseBelow, slotsBelow };
}

/** Nodes: live topics, retired ones, and stale proposals clustering no longer knows. */
function diffTaxonomyNodes(
  tenantId: string,
  live: readonly Topic[],
  retired: readonly string[],
  spaceOf: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, TaxonomyNode>,
  names: ReadonlyMap<string, NamedTopic>,
  total: ReadonlyMap<string, number>,
): { writes: TaxonomyNode[]; retiring: Set<string> } {
  const liveKeys = new Set(live.map((t) => t.key));
  const ordinals = new Map<string, number>();
  for (const n of nodes.values()) {
    const parent = n.parent_key ?? "";
    ordinals.set(parent, Math.max(ordinals.get(parent) ?? -1, n.ordinal));
  }
  const nextOrdinal = (parent: string | undefined) => {
    const n = (ordinals.get(parent ?? "") ?? -1) + 1;
    ordinals.set(parent ?? "", n);
    return n;
  };
  const writes: TaxonomyNode[] = [];
  const byWeight = (a: Topic, b: Topic) => b.statements - a.statements || (a.key < b.key ? -1 : 1);
  for (const t of [...live].sort((a, b) => a.level - b.level || byWeight(a, b))) {
    const before = nodes.get(t.key);
    const named = names.get(t.key);
    const { parent_key: _parent, ...rest } = before ?? ({} as Partial<TaxonomyNode>);
    const next: TaxonomyNode = {
      ...rest,
      key: t.key,
      tenant_id: tenantId,
      space_id: spaceOf.get(t.key) as string,
      title: before?.title ?? named?.title ?? t.key,
      ordinal: before?.ordinal ?? nextOrdinal(t.parent),
      statement_count: total.get(t.key) ?? 0,
      ...(t.parent && { parent_key: t.parent }),
      ...(!before && { status: "proposed" as const }),
      ...(!before && named?.summary && { summary: named.summary }),
    };
    if (!before || canonical(next) !== canonical(before)) writes.push(next);
  }
  const retiring = new Set(retired);
  for (const n of nodes.values()) {
    if (!liveKeys.has(n.key) && n.status !== "retired" && !isConfirmed(n)) retiring.add(n.key);
  }
  for (const k of retiring) {
    const before = nodes.get(k);
    if (before && (before.status !== "retired" || before.statement_count !== 0)) {
      writes.push({ ...before, status: "retired", statement_count: 0 });
    }
  }
  return { writes, retiring };
}

function diffPlacements(
  tenantId: string,
  sections: readonly Section[],
  placed: ReadonlyMap<string, Placement>,
  desired: ReadonlyMap<string, Target>,
  at: string,
  report: ReclusterReport,
): { place: Placement[]; unplace: string[] } {
  const place: Placement[] = [];
  const unplace: string[] = [];
  for (const s of sections) {
    for (const c of s.claims) {
      const p = placed.get(c.id);
      if (fixed(p)) continue;
      const target = desired.get(c.id);
      if (p && clustered(s)) {
        report.churn.before++;
        if (p.taxonomy_key !== target?.topic) report.churn.moved++;
      }
      if (target && p?.taxonomy_key !== target.topic) place.push(makePlacement(tenantId, s.space_id, c.id, target, at));
      if (!target && p) unplace.push(c.id);
    }
  }
  return { place, unplace };
}

async function persistRecords(
  records: Records,
  tenantId: string,
  sections: readonly Section[],
  topicOf: ReadonlyMap<string, { topic: string; score: number } | undefined>,
  live: readonly Topic[],
  states: readonly TopicState[],
  spaceOf: ReadonlyMap<string, string>,
  slotRows: readonly SlotTopic[],
): Promise<void> {
  const liveKeys = new Set(live.map((t) => t.key));
  const sectionWrites = sections.flatMap((s) => {
    if (!clustered(s) || !topicOf.has(s.key)) return [];
    const to = topicOf.get(s.key);
    if (to?.topic === s.topic && to?.score === s.score) return [];
    const { topic: _topic, score: _score, ...rest } = s;
    return [to ? { ...rest, topic: to.topic, score: to.score } : rest];
  });
  const stateWrites: TopicState[] = live.map((t) => ({
    tenant_id: tenantId,
    key: t.key,
    space_id: spaceOf.get(t.key) as string,
    level: t.level,
    ...(t.parent && { parent: t.parent }),
    leaf: t.leaf,
    centroid: quantize(t.centroid),
  }));
  for (const s of states) {
    if (!s.retired && !liveKeys.has(s.key)) stateWrites.push({ ...s, leaf: false, retired: true });
  }
  const slotKeys = new Set(slotRows.map((r) => SLOTS.key(r)));
  const staleSlots = (await records.find(SLOTS, { tenant_id: tenantId }))
    .map((r) => SLOTS.key(r))
    .filter((k) => !slotKeys.has(k));
  await records.transaction(async (tx) => {
    if (sectionWrites.length) await tx.put(SECTIONS, sectionWrites);
    if (stateWrites.length) await tx.put(TOPICS, stateWrites);
    if (staleSlots.length) await tx.delete(SLOTS, staleSlots);
    if (slotRows.length) await tx.put(SLOTS, [...slotRows]);
  });
}

function populateReportTopics(
  report: ReclusterReport,
  live: readonly Topic[],
  nodes: ReadonlyMap<string, TaxonomyNode>,
  createdCount: number,
  retiring: ReadonlySet<string>,
  total: ReadonlyMap<string, number>,
  slotsBelow: ReadonlyMap<string, ReadonlySet<string>>,
  looseBelow: ReadonlyMap<string, number>,
): void {
  for (const t of live) {
    report.topics.by_level[String(t.level) as "1" | "2" | "3"]++;
    if (t.leaf) report.sizes.leaves.push(total.get(t.key) ?? 0);
    if (t.level === 2) {
      report.sizes.topics.push(total.get(t.key) ?? 0);
      report.sizes.topic_slots.push(slotsBelow.get(t.key)?.size ?? 0);
      report.sizes.topic_distinct.push((slotsBelow.get(t.key)?.size ?? 0) + (looseBelow.get(t.key) ?? 0));
    }
    if (isConfirmed(nodes.get(t.key))) report.topics.confirmed++;
  }
  report.topics.live = live.length;
  report.topics.created = createdCount;
  report.topics.retired = [...retiring].filter((k) => nodes.get(k)?.status !== "retired").length;
}

export async function reclusterTenant(deps: ReclusterDeps, tenantId: string): Promise<ReclusterReport> {
  await flushPending(deps.store, deps.records, tenantId);
  const sections = await deps.records.find(SECTIONS, { tenant_id: tenantId });
  const states = await deps.records.find(TOPICS, { tenant_id: tenantId });
  const nodes = new Map((await deps.store.topics(tenantId)).map((n) => [n.key, n]));
  const claimIds = [...new Set(sections.flatMap((s) => s.claims.map((c) => c.id)))];
  const placed = new Map((await batched(claimIds, (ids) => deps.store.placementsOf(ids))).map((p) => [p.claim_id, p]));
  const acc: SpaceClusterAccum = {
    live: [],
    retired: [],
    spaceOf: new Map(),
    topicOf: new Map(),
    desired: new Map(),
    slotRows: [],
    reserved: [...nodes.keys(), ...states.map((t) => t.key)],
    report: emptyReport(tenantId),
  };
  for (const space of [...new Set(sections.map((s) => s.space_id))].sort()) {
    clusterSpace(
      tenantId,
      space,
      sections.filter((s) => s.space_id === space),
      states.filter((t) => t.space_id === space),
      nodes,
      placed,
      deps.options,
      acc,
    );
  }

  const naming = await nameNewTopics(deps, tenantId, acc.live, nodes, sections);
  acc.report.named = naming.named;
  acc.report.model_calls = naming.calls;

  const { total, looseBelow, slotsBelow } = countStatements(sections, placed, acc.desired, nodes, acc.live, acc.report);
  const { writes, retiring } = diffTaxonomyNodes(
    tenantId,
    acc.live,
    acc.retired,
    acc.spaceOf,
    nodes,
    naming.names,
    total,
  );
  const { place, unplace } = diffPlacements(
    tenantId,
    sections,
    placed,
    acc.desired,
    deps.clock().toISOString(),
    acc.report,
  );

  await deps.store.transaction(async (tx) => {
    if (writes.length) await tx.putTopics(writes);
    for (let i = 0; i < unplace.length; i += READ_BATCH) await tx.unplace(unplace.slice(i, i + READ_BATCH));
    for (let i = 0; i < place.length; i += READ_BATCH) await tx.place(place.slice(i, i + READ_BATCH));
  });

  await persistRecords(deps.records, tenantId, sections, acc.topicOf, acc.live, states, acc.spaceOf, acc.slotRows);
  populateReportTopics(acc.report, acc.live, nodes, naming.created.length, retiring, total, slotsBelow, looseBelow);

  log.debug("re-clustered", {
    tenant: tenantId,
    topics: acc.report.topics.live,
    created: acc.report.topics.created,
    moved: acc.report.churn.moved,
  });
  return acc.report;
}
