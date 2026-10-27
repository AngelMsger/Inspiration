/**
 * First citations of reference passages. Extraction reads a reference document only where it
 * names a catalogue fact; when a page or an answer first cites another passage of it,
 * extractOnUse reads that passage in full. onUse() samples such passages across the corpus,
 * reads each as a first citation would, and times it. With the mocked model the times
 * measure the pipeline (store reads, the gateway, the writes), not the model.
 */

import { levelOf } from "@inspiration/contracts";
import type { Corpus, Engine } from "@inspiration/engine";
import { type Spread, spread } from "./claims.ts";

export interface OnUseReport {
  /** Reference documents, and the passages sampled from them that no claim cited yet. */
  documents: number;
  uses: number;
  /** Milliseconds from the citation until the passage's claims are stored. */
  ms: Spread;
  /** Model calls, and claims each use added. */
  windows: number;
  claims: number;
  claims_per_use: Spread;
}

/** Kinds of block a reader cites; headings and table containers are never read on their own. */
const CITED = new Set(["paragraph", "list_item", "table_row", "quote", "form_field"]);

/**
 * Read up to `sample` reference passages as first citations would: one passage no claim cites
 * yet from each of that many reference documents, spread evenly over the corpus.
 */
export async function onUse(engine: Engine, corpus: Corpus, sample: number): Promise<OnUseReport> {
  const versions: string[] = [];
  for (const source of corpus.sources) {
    for (const doc of await engine.normalization.documents(source.id)) {
      if (doc.status === "deleted") continue;
      const version = await engine.store.getSourceVersion(doc.source_version_id);
      if (version && !version.deleted && levelOf(version) === "reference") versions.push(version.id);
    }
  }
  const step = Math.max(1, versions.length / Math.max(1, sample));
  const times: number[] = [];
  const added: number[] = [];
  let windows = 0;
  for (let i = 0; i < versions.length && times.length < sample; i += step) {
    const versionId = versions[Math.floor(i)] as string;
    const blocks = (await engine.store.blocksOf(versionId))
      .filter((b) => CITED.has(b.kind) && b.span_ids.length)
      .sort((a, b) => a.ordinal - b.ordinal);
    const cited = new Set<string>();
    const claims = await engine.store.getClaims(await engine.store.claimsCiting(blocks.flatMap((b) => b.span_ids)));
    for (const evidence of await engine.store.evidenceOf(claims.map((c) => c.id))) cited.add(evidence.span_id);
    const passage = blocks.find((b) => !b.span_ids.some((s) => cited.has(s)));
    if (!passage) continue;
    const started = performance.now();
    const result = await engine.extraction.extractOnUse(versionId, [passage.id]);
    times.push(performance.now() - started);
    windows += result.windows;
    added.push(result.added.length);
  }
  // Governance and freshness take the new claims as they would after a real citation.
  await engine.settle();
  return {
    documents: versions.length,
    uses: times.length,
    ms: spread(times.map((t) => Math.round(t))),
    windows,
    claims: added.reduce((a, b) => a + b, 0),
    claims_per_use: spread(added),
  };
}

export function onUseSummary(r: OnUseReport): string {
  return [
    `first citations: ${r.uses} reference passages read in full when first cited (from ${r.documents} reference documents)`,
    `  ms per citation median ${r.ms.median}, p90 ${r.ms.p90}, max ${r.ms.max} (mocked model); ${r.windows} model calls; claims added ${r.claims} (per citation median ${r.claims_per_use.median}, max ${r.claims_per_use.max})`,
  ].join("\n");
}
