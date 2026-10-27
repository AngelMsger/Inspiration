/**
 * The knowledge outline after a run: page-compiler re-clusters the tenant's governed
 * sections into topics and places every statement. outlineReport() runs it twice, the second
 * time with nothing changed, which must move nothing. The numbers the UI designs against are
 * the topic sizes (statements per topic and per leaf), the distinct fact slots per topic, the
 * unfiled share, and the churn per re-cluster: placed statements that moved, against the
 * change budget.
 */

import type { Engine } from "@inspiration/engine";
import type { ReclusterReport } from "@inspiration/page-compiler";
import { type Spread, spread } from "./claims.ts";

export interface OutlineRun {
  ms: number;
  topics: ReclusterReport["topics"];
  sections: number;
  statements: number;
  placed: ReclusterReport["placed"];
  unfiled: number;
  churn: ReclusterReport["churn"];
  /**
   * Statements per topic (subtopics included) and per leaf topic; fact slots per topic, and
   * distinct statements per topic, a slot counted once.
   */
  sizes: { topics: Spread; leaves: Spread; slots: Spread; distinct: Spread };
  /** Topics over the 100 statements the UI shows before a split, counting statements and distinct ones. */
  over_100: { statements: number; distinct: number };
  named: number;
  model_calls: number;
}

export interface OutlineReport {
  run: OutlineRun;
  /** The same re-cluster again, with nothing changed in between. */
  again: OutlineRun;
}

async function recluster(engine: Engine, tenantId: string): Promise<OutlineRun> {
  const started = performance.now();
  const r = await engine.topics.recluster(tenantId);
  return {
    ms: Math.round(performance.now() - started),
    topics: r.topics,
    sections: r.sections,
    statements: r.statements,
    placed: r.placed,
    unfiled: r.unfiled,
    churn: r.churn,
    sizes: {
      topics: spread(r.sizes.topics),
      leaves: spread(r.sizes.leaves),
      slots: spread(r.sizes.topic_slots),
      distinct: spread(r.sizes.topic_distinct),
    },
    over_100: {
      statements: r.sizes.topics.filter((n) => n > 100).length,
      distinct: r.sizes.topic_distinct.filter((n) => n > 100).length,
    },
    named: r.named,
    model_calls: r.model_calls,
  };
}

export async function outlineReport(engine: Engine, tenantId: string): Promise<OutlineReport> {
  const run = await recluster(engine, tenantId);
  return { run, again: await recluster(engine, tenantId) };
}

export function outlineLines(o: OutlineReport): string[] {
  const pct = (n: number, of: number) => (of ? `${Math.round((1000 * n) / of) / 10}%` : "0%");
  const { run, again } = o;
  const t = run.topics;
  const s = run.sizes;
  const governed = run.placed.governed + run.unfiled;
  return [
    `outline: ${t.live} topics (areas ${t.by_level["1"]}, topics ${t.by_level["2"]}, subtopics ${t.by_level["3"]}; ${t.created} new, ${t.retired} retired, ${t.confirmed} confirmed) from ${run.sections} governed sections in ${run.ms} ms`,
    `  statements per topic median ${s.topics.median}, p90 ${s.topics.p90}, max ${s.topics.max} (${run.over_100.statements} over 100); per leaf median ${s.leaves.median}, max ${s.leaves.max}`,
    `  distinct per topic, a fact slot counted once: median ${s.distinct.median}, p90 ${s.distinct.p90}, max ${s.distinct.max} (${run.over_100.distinct} over 100); fact slots per topic median ${s.slots.median}, max ${s.slots.max}`,
    `  placed ${run.placed.governed} governed and ${run.placed.reference} reference statements; unfiled ${run.unfiled} (${pct(run.unfiled, governed)} of governed); ${run.model_calls} naming calls`,
    `  churn: ${run.churn.moved} of ${run.churn.before} placed statements moved (${pct(run.churn.moved, run.churn.before)}), ${run.churn.deferred} kept by the change budget; again with no change: ${again.churn.moved} of ${again.churn.before} moved, ${again.topics.created} new topics`,
  ];
}
