/**
 * Topic owners for a run's report: the engine process assigns them (assignOwners in
 * apps/engine, the business layer's stand-in), and the report counts them.
 */

import { type Corpus, type Engine, assignOwners as ownTopics } from "@inspiration/engine";
import { type Spread, spread } from "./claims.ts";

export interface OwnersReport {
  /** Live topics, those with an owner after the run, and those this run gave one. */
  topics: number;
  owned: number;
  assigned: number;
  /** Members owning a topic, and how many topics each owns. */
  owners: number;
  topics_per_owner: Spread;
  /** Open todos the inbox moved to their new owners. */
  rerouted: number;
}

export async function assignOwners(engine: Engine, corpus: Corpus): Promise<OwnersReport> {
  const { topics, assigned, owners, rerouted } = await ownTopics(engine, corpus);
  const counts = [...owners.values()];
  return {
    topics,
    owned: counts.reduce((a, b) => a + b, 0),
    assigned,
    owners: owners.size,
    topics_per_owner: spread(counts),
    rerouted,
  };
}

export function ownersLines(o: OwnersReport): string[] {
  return [
    `owners: ${o.owned} of ${o.topics} topics owned (${o.assigned} assigned now) by ${o.owners} members, topics per owner median ${o.topics_per_owner.median}, max ${o.topics_per_owner.max}; ${o.rerouted} open todos rerouted`,
  ];
}
