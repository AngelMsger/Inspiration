/**
 * Topic clustering, the pure part. Units are sections of governed documents, each with an
 * embedding and a count of statements; topics are areas, topics and subtopics (levels 1 to
 * 3) with keys that survive re-clustering.
 *
 * A run starts from the previous topics, as anchors:
 * - Topics: each unit, in key order, stays in its previous topic while it is at least `keep`
 *   similar to it; otherwise it joins the most similar topic at `join` or more, or seeds a
 *   new one. A topic with fewer than minStatements statements is dissolved and its units
 *   are unfiled, unless an owner confirmed it.
 * - Documents: the unfiled units of one document form a topic of their own when they hold
 *   minStatements statements together (its key comes from the document), since a document's
 *   sections are about one thing more often than not.
 * - Subtopics: a topic with more than maxStatements statements, or one split before, is
 *   split the same way at `subJoin`. Subtopics too small for minStatements merge into their
 *   closest sibling, and a split that leaves one subtopic is undone, unless an owner confirmed
 *   that subtopic.
 * - Change budget: statements that would leave a topic that still exists move only up to
 *   `budget` of the statements placed before; the moves that gain least wait for a later
 *   run.
 * - Areas: topics group into areas at `area` similarity of their centroids, keeping their
 *   previous area at `areaKeep`. An area of one topic is dropped and the topic is a root.
 * Keys are new only for new topics, from the unit or topic that seeded them, and never one
 * of the reserved keys (retired topics, topics made elsewhere).
 */

import { createHash } from "node:crypto";

export type Level = 1 | 2 | 3;

export interface Unit {
  key: string;
  /** Unit length. */
  vector: Float32Array;
  statements: number;
  /** The leaf topic it was in before this run. */
  previous?: string;
  /** Its document, whose other unfiled units it may form a topic with. */
  document?: string;
}

export interface Anchor {
  key: string;
  level: Level;
  parent?: string;
  centroid: Float32Array;
  /** An owner confirmed it: it is never dissolved or retired. */
  confirmed?: boolean;
}

export interface Topic {
  key: string;
  level: Level;
  parent?: string;
  centroid: Float32Array;
  /** Units below it, for an area those of its topics. */
  units: string[];
  statements: number;
  /** Seeded in this run. */
  created: boolean;
  /** Its leaf topics hold the units: false for areas and split topics. */
  leaf: boolean;
}

export interface Clustering {
  /** Live topics: areas first, then topics and subtopics, each level by key. */
  topics: Topic[];
  /** Anchors that are not live any more. */
  retired: string[];
  /** Each placed unit's leaf topic and its similarity to it. */
  placed: Map<string, { topic: string; score: number }>;
  unfiled: string[];
  /** Statements placed before the run, those that changed topic, and those the budget kept. */
  before: number;
  moved: number;
  deferred: number;
}

export interface ClusterOptions {
  join: number;
  keep: number;
  subJoin: number;
  area: number;
  areaKeep: number;
  minStatements: number;
  maxStatements: number;
  budget: number;
}

export const CLUSTER_DEFAULTS: ClusterOptions = {
  join: 0.5,
  keep: 0.4,
  subJoin: 0.6,
  area: 0.35,
  areaKeep: 0.3,
  minStatements: 5,
  maxStatements: 100,
  budget: 0.05,
};

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** The normalized mean of vectors; zero when there are none. */
export function centroidOf(vectors: readonly Float32Array[], dims: number): Float32Array {
  const c = new Float32Array(dims);
  for (const v of vectors) for (let i = 0; i < dims; i++) c[i] = (c[i] as number) + (v[i] as number);
  const norm = Math.hypot(...c) || 1;
  for (let i = 0; i < dims; i++) c[i] = (c[i] as number) / norm;
  return c;
}

export function topicKey(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\x1f")).digest("hex").slice(0, 12)}`;
}

interface Group {
  key: string;
  centroid: Float32Array;
  /** Fixed for anchors during a pass; a running sum for groups seeded in it. */
  sum?: Float32Array;
  members: Unit[];
  created: boolean;
}

/**
 * One leader pass: every unit stays in its previous group at `keep`, else joins the most
 * similar group at `join`, else seeds one.
 */
function leader(
  units: readonly Unit[],
  anchors: readonly { key: string; centroid: Float32Array }[],
  previousOf: (u: Unit) => string | undefined,
  thresholds: { join: number; keep: number },
  seedKey: (u: Unit) => string,
  taken: Set<string>,
): Group[] {
  const groups: Group[] = anchors.map((a) => ({ key: a.key, centroid: a.centroid, members: [], created: false }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const u of units) {
    const previous = previousOf(u);
    const home = previous === undefined ? undefined : byKey.get(previous);
    if (home && dot(u.vector, home.centroid) >= thresholds.keep) {
      home.members.push(u);
      continue;
    }
    let best: Group | undefined;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (const g of groups) {
      const sim = dot(u.vector, g.centroid);
      if (sim > bestSim) {
        best = g;
        bestSim = sim;
      }
    }
    if (best && bestSim >= thresholds.join) {
      best.members.push(u);
      if (best.sum) {
        for (let i = 0; i < best.sum.length; i++) best.sum[i] = (best.sum[i] as number) + (u.vector[i] as number);
        best.centroid = centroidOf([best.sum], best.sum.length);
      }
      continue;
    }
    let key = seedKey(u);
    for (let n = 2; taken.has(key); n++) key = `${seedKey(u)}-${n}`;
    taken.add(key);
    const g: Group = { key, centroid: u.vector, sum: Float32Array.from(u.vector), members: [u], created: true };
    groups.push(g);
    byKey.set(key, g);
  }
  return groups;
}

const statementsOf = (units: readonly Unit[]) => units.reduce((n, u) => n + u.statements, 0);

export function cluster(
  scope: string,
  units: readonly Unit[],
  anchors: readonly Anchor[],
  options: Partial<ClusterOptions> = {},
  reserved: Iterable<string> = [],
): Clustering {
  const o = { ...CLUSTER_DEFAULTS, ...options };
  const dims = units[0]?.vector.length ?? anchors[0]?.centroid.length ?? 0;
  const ordered = [...units].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const anchorByKey = new Map(anchors.map((a) => [a.key, a]));
  const taken = new Set([...anchors.map((a) => a.key), ...reserved]);
  const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  /** The previous topic (level 2) of a unit: its leaf, or the leaf's parent. */
  const previousTopic = (u: Unit) => {
    const leaf = u.previous === undefined ? undefined : anchorByKey.get(u.previous);
    return leaf?.level === 3 ? leaf.parent : leaf?.key;
  };

  // Topics.
  const topicAnchors = anchors.filter((a) => a.level === 2).sort(byKey);
  const groups = leader(ordered, topicAnchors, previousTopic, o, (u) => topicKey("t", scope, u.key), taken);
  const unfiled: Unit[] = [];
  const topics = groups.filter((g) => {
    if (!g.members.length) return anchorByKey.get(g.key)?.confirmed === true;
    if (statementsOf(g.members) >= o.minStatements || anchorByKey.get(g.key)?.confirmed) return true;
    unfiled.push(...g.members);
    return false;
  });

  // What is left of a document, together. The document's topic from an earlier run comes back
  // under its key; a key retired before is never reused.
  const byDocument = new Map<string, Unit[]>();
  for (const u of unfiled)
    if (u.document !== undefined) byDocument.set(u.document, [...(byDocument.get(u.document) ?? []), u]);
  const kept = new Map(topics.map((t) => [t.key, t]));
  for (const [document, members] of [...byDocument].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (statementsOf(members) < o.minStatements) continue;
    let key = topicKey("t", scope, "document", document);
    const known = kept.get(key);
    if (known) known.members.push(...members);
    else {
      if (!anchorByKey.has(key))
        for (let n = 2; taken.has(key); n++) key = `${topicKey("t", scope, "document", document)}-${n}`;
      taken.add(key);
      const group: Group = {
        key,
        centroid: centroidOf(
          members.map((u) => u.vector),
          dims,
        ),
        members: [...members],
        created: !anchorByKey.has(key),
      };
      topics.push(group);
      kept.set(key, group);
    }
    for (const u of members) unfiled.splice(unfiled.indexOf(u), 1);
  }

  // Subtopics.
  const leafOf = new Map<string, string>();
  const subtopics = new Map<string, Group[]>();
  for (const t of topics) {
    const before = anchors.filter((a) => a.level === 3 && a.parent === t.key).sort(byKey);
    if (statementsOf(t.members) <= o.maxStatements && !before.length) {
      for (const u of t.members) leafOf.set(u.key, t.key);
      continue;
    }
    let children = leader(
      t.members,
      before,
      (u) => u.previous,
      { join: o.subJoin, keep: o.subJoin - (o.join - o.keep) },
      (u) => topicKey("t", t.key, u.key),
      taken,
    ).filter((c) => c.members.length || anchorByKey.get(c.key)?.confirmed);
    // Too small to stand alone: into the closest sibling, the smallest first.
    for (;;) {
      const small = children
        .filter((c) => statementsOf(c.members) < o.minStatements && !anchorByKey.get(c.key)?.confirmed)
        .sort((a, b) => statementsOf(a.members) - statementsOf(b.members) || byKey(a, b))[0];
      if (!small || children.length < 2) break;
      children = children.filter((c) => c !== small);
      const into = children.reduce((best, c) =>
        dot(c.centroid, small.centroid) > dot(best.centroid, small.centroid) ? c : best,
      );
      into.members.push(...small.members);
    }
    if (children.length < 2 && !children.some((c) => anchorByKey.get(c.key)?.confirmed)) {
      for (const u of t.members) leafOf.set(u.key, t.key);
      continue;
    }
    subtopics.set(t.key, children);
    for (const c of children) for (const u of c.members) leafOf.set(u.key, c.key);
  }

  // Change budget: moves away from a topic that is still a leaf wait when there are too many.
  const unitByKey = new Map(units.map((u) => [u.key, u]));
  const centroids = new Map<string, Float32Array>();
  const leafCentroid = (key: string) => {
    let c = centroids.get(key);
    if (!c) {
      const members = [...leafOf].filter(([, k]) => k === key).map(([u]) => (unitByKey.get(u) as Unit).vector);
      c = members.length ? centroidOf(members, dims) : (anchorByKey.get(key)?.centroid ?? new Float32Array(dims));
      centroids.set(key, c);
    }
    return c;
  };
  const leaves = new Set(leafOf.values());
  const before = statementsOf(units.filter((u) => u.previous !== undefined && anchorByKey.has(u.previous)));
  const moves = units
    .filter((u) => u.previous !== undefined && anchorByKey.has(u.previous) && leafOf.get(u.key) !== u.previous)
    .map((u) => {
      const to = leafOf.get(u.key);
      const stays = leaves.has(u.previous as string);
      const gain = (to ? dot(u.vector, leafCentroid(to)) : 0) - dot(u.vector, leafCentroid(u.previous as string));
      return { u, stays, gain };
    });
  let moved = statementsOf(moves.map((m) => m.u));
  let deferred = 0;
  const limit = Math.floor(o.budget * before);
  for (const m of moves.filter((x) => x.stays).sort((a, b) => a.gain - b.gain || byKey(a.u, b.u))) {
    if (moved <= limit) break;
    leafOf.set(m.u.key, m.u.previous as string);
    const i = unfiled.indexOf(m.u);
    if (i >= 0) unfiled.splice(i, 1);
    moved -= m.u.statements;
    deferred += m.u.statements;
  }

  // Leaf and topic membership after the budget, and their centroids.
  const membersOf = new Map<string, Unit[]>();
  for (const [u, k] of leafOf) membersOf.set(k, [...(membersOf.get(k) ?? []), unitByKey.get(u) as Unit]);
  const live: Topic[] = [];
  const make = (key: string, level: Level, members: Unit[], created: boolean, leaf: boolean, parent?: string) => {
    const centroid = members.length
      ? centroidOf(
          members.map((u) => u.vector),
          dims,
        )
      : (anchorByKey.get(key)?.centroid ?? new Float32Array(dims));
    const topic: Topic = {
      key,
      level,
      centroid,
      units: members.map((u) => u.key).sort(),
      statements: statementsOf(members),
      created,
      leaf,
      ...(parent && { parent }),
    };
    live.push(topic);
    return topic;
  };
  const level2: Topic[] = [];
  for (const t of topics) {
    const children = subtopics.get(t.key);
    const below = children ? children.flatMap((c) => membersOf.get(c.key) ?? []) : (membersOf.get(t.key) ?? []);
    level2.push(make(t.key, 2, below, t.created, !children));
    for (const c of children ?? []) make(c.key, 3, membersOf.get(c.key) ?? [], c.created, true, t.key);
  }

  // Areas.
  const areaAnchors = anchors.filter((a) => a.level === 1).sort(byKey);
  const asUnits: Unit[] = [...level2].sort(byKey).map((t) => {
    const parent = anchorByKey.get(t.key)?.parent;
    return { key: t.key, vector: t.centroid, statements: t.statements, ...(parent && { previous: parent }) };
  });
  const areas = leader(
    asUnits,
    areaAnchors,
    (u) => u.previous,
    { join: o.area, keep: o.areaKeep },
    (u) => topicKey("a", scope, u.key),
    taken,
  );
  const topicByKey = new Map(level2.map((t) => [t.key, t]));
  const areaTopics: Topic[] = [];
  for (const a of areas) {
    const confirmed = anchorByKey.get(a.key)?.confirmed === true;
    if (a.members.length < 2 && !confirmed) continue;
    const members = a.members.map((m) => topicByKey.get(m.key) as Topic);
    for (const t of members) t.parent = a.key;
    const unitsBelow = members.flatMap((t) => t.units.map((k) => unitByKey.get(k) as Unit));
    const area = make(a.key, 1, unitsBelow, a.created, false);
    area.units = unitsBelow.map((u) => u.key).sort();
    areaTopics.push(area);
  }

  const liveKeys = new Set(live.map((t) => t.key));
  const placed = new Map<string, { topic: string; score: number }>();
  const liveByKey = new Map(live.map((t) => [t.key, t]));
  for (const [u, k] of leafOf) {
    const sim = dot((unitByKey.get(u) as Unit).vector, (liveByKey.get(k) as Topic).centroid);
    placed.set(u, { topic: k, score: Math.max(0, Math.min(1, Math.round(sim * 1000) / 1000)) });
  }
  const order = (t: Topic) => t.level;
  return {
    topics: live.sort((a, b) => order(a) - order(b) || byKey(a, b)),
    retired: anchors
      .filter((a) => !liveKeys.has(a.key))
      .map((a) => a.key)
      .sort(),
    placed,
    unfiled: unfiled.map((u) => u.key).sort(),
    before,
    moved,
    deferred,
  };
}
