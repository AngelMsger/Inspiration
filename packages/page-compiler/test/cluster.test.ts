import { describe, expect, test } from "vitest";
import { type Anchor, type Clustering, cluster, topicKey, type Unit } from "../src/cluster.ts";

const DIMS = 12;

/** A deterministic random number in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function unit(direction: Record<number, number>, noise: number, next: () => number): Float32Array {
  const v = new Float32Array(DIMS);
  for (const [i, x] of Object.entries(direction)) v[Number(i)] = x;
  for (let i = 0; i < DIMS; i++) v[i] = (v[i] as number) + (next() - 0.5) * noise;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** `count` units around a direction, keyed `<prefix>-<n>`. */
function group(prefix: string, direction: Record<number, number>, count: number, statements = 3, seed = 1): Unit[] {
  const next = random(seed + prefix.length * 7919);
  return Array.from({ length: count }, (_, n) => ({
    key: `${prefix}-${String(n).padStart(2, "0")}`,
    vector: unit(direction, 0.3, next),
    statements,
  }));
}

/** The units of the last run with their topics, and its topics as anchors. */
function rerun(units: readonly Unit[], last: Clustering): [Unit[], Anchor[]] {
  const again = units.map((u) => {
    const at = last.placed.get(u.key);
    return at ? { ...u, previous: at.topic } : { key: u.key, vector: u.vector, statements: u.statements };
  });
  const anchors = last.topics.map((t) => ({
    key: t.key,
    level: t.level,
    ...(t.parent && { parent: t.parent }),
    centroid: t.centroid,
  }));
  return [again, anchors];
}

const topicOf = (r: Clustering, unitKey: string) => r.placed.get(unitKey)?.topic;

describe("cluster", () => {
  test("similar units form topics whose keys survive the next run", () => {
    const units = [...group("hotel", { 0: 1 }, 6), ...group("leave", { 1: 1 }, 6), ...group("pay", { 2: 1 }, 6)];
    const first = cluster("spc", units, []);
    const topics = first.topics.filter((t) => t.level === 2);
    expect(topics).toHaveLength(3);
    for (const prefix of ["hotel", "leave", "pay"]) {
      const keys = new Set(units.filter((u) => u.key.startsWith(prefix)).map((u) => topicOf(first, u.key)));
      expect(keys.size).toBe(1);
    }
    expect(first.unfiled).toEqual([]);
    expect(first.before).toBe(0);
    // A new topic's key comes from the unit that seeded it.
    expect(topics.map((t) => t.key).sort()).toEqual(
      ["hotel-00", "leave-00", "pay-00"].map((k) => topicKey("t", "spc", k)).sort(),
    );
    expect(topics.every((t) => t.created && t.leaf && t.statements === 18)).toBe(true);
    for (const p of first.placed.values()) expect(p.score).toBeGreaterThan(0.5);

    const second = cluster("spc", ...rerun(units, first));
    expect(second.topics.map((t) => t.key)).toEqual(first.topics.map((t) => t.key));
    expect(second.topics.some((t) => t.created)).toBe(false);
    expect([second.before, second.moved, second.deferred, second.retired.length]).toEqual([54, 0, 0, 0]);
  });

  test("a topic too small to stand alone is unfiled, unless an owner confirmed it", () => {
    const units = [...group("hotel", { 0: 1 }, 6), ...group("odd", { 5: 1 }, 2, 1)];
    const first = cluster("spc", units, []);
    expect(first.topics.filter((t) => t.level === 2)).toHaveLength(1);
    expect(first.unfiled).toEqual(["odd-00", "odd-01"]);

    const odd = topicKey("t", "spc", "odd-00");
    const confirmed: Anchor = { key: odd, level: 2, centroid: unit({ 5: 1 }, 0, random(1)), confirmed: true };
    const kept = cluster("spc", units, [confirmed]);
    expect(topicOf(kept, "odd-00")).toBe(odd);
    expect(kept.unfiled).toEqual([]);
    // A confirmed topic stays even when nothing is left in it.
    const empty = cluster("spc", group("hotel", { 0: 1 }, 6), [confirmed]);
    expect(empty.topics.map((t) => t.key)).toContain(odd);
    expect(empty.retired).toEqual([]);
  });

  test("a topic over maxStatements splits into subtopics when its sections differ", () => {
    // Two kinds of hotel sections, close enough for one topic, far enough for two subtopics.
    const units = [...group("cap", { 0: 1, 3: 0.55 }, 8, 4), ...group("booking", { 0: 1, 4: 0.55 }, 8, 4)];
    const options = { maxStatements: 40, subJoin: 0.8 };
    const first = cluster("spc", units, [], options);
    const top = first.topics.filter((t) => t.level === 2);
    const subs = first.topics.filter((t) => t.level === 3);
    expect(top).toHaveLength(1);
    expect(top[0]?.leaf).toBe(false);
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.parent === top[0]?.key && s.statements === 32)).toBe(true);
    expect(new Set(units.filter((u) => u.key.startsWith("cap")).map((u) => topicOf(first, u.key))).size).toBe(1);

    // The split holds in the next run, even under maxStatements.
    const [again, anchors] = rerun(units, first);
    const second = cluster("spc", again, anchors, options);
    expect(second.topics.map((t) => t.key)).toEqual(first.topics.map((t) => t.key));
    expect(second.moved).toBe(0);

    // Sections that do not differ are not split, however many statements they hold.
    const same = cluster("spc", group("cap", { 0: 1 }, 16, 4), [], { maxStatements: 40, subJoin: 0.6 });
    expect(same.topics.map((t) => t.level)).toEqual([2]);
  });

  test("the change budget keeps most moves for a later run", () => {
    const units = [...group("a", { 0: 1 }, 20, 1), ...group("b", { 1: 1 }, 20, 1)];
    const first = cluster("spc", units, []);
    const [again, anchors] = rerun(units, first);
    // Eight sections of a are rewritten to read like b.
    const drifted = again.map((u, i) =>
      u.key.startsWith("a") && i < 8 ? { ...u, vector: units[20 + i]?.vector as Float32Array } : u,
    );
    const second = cluster("spc", drifted, anchors, { budget: 0.05 });
    expect(second.before).toBe(40);
    expect(second.moved).toBe(2);
    expect(second.deferred).toBe(6);
    const free = cluster("spc", drifted, anchors, { budget: 1 });
    expect([free.moved, free.deferred]).toEqual([8, 0]);
  });

  test("close topics group into an area; an area of one topic is dropped", () => {
    const units = [
      ...group("hotel", { 0: 1, 6: 0.9 }, 6),
      ...group("meals", { 1: 1, 6: 0.9 }, 6),
      ...group("leave", { 2: 1 }, 6),
    ];
    const r = cluster("spc", units, [], { area: 0.35 });
    const areas = r.topics.filter((t) => t.level === 1);
    expect(areas).toHaveLength(1);
    const children = r.topics.filter((t) => t.parent === areas[0]?.key);
    expect(children.map((t) => t.units[0]?.split("-")[0]).sort()).toEqual(["hotel", "meals"]);
    expect(r.topics.find((t) => t.units.includes("leave-00") && t.level === 2)?.parent).toBeUndefined();
    expect(areas[0]?.statements).toBe(36);
  });

  test("retired keys are never used again", () => {
    const units = group("hotel", { 0: 1 }, 6);
    const reused = topicKey("t", "spc", "hotel-00");
    const r = cluster("spc", units, [], {}, [reused]);
    expect(r.topics[0]?.key).toBe(`${reused}-2`);
  });
});
