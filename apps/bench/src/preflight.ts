/**
 * Checks a run makes before it pays, all free, so that money is not spent on a run that
 * cannot measure what it is for (docs/design/validation.md, "How runs stay cheap"). On
 * 2026-11-02 the decisive test's first paid reading ran on a corpus without a fact catalogue:
 * no statement got a slot, governance decided nothing, and the reading check's line naming
 * the 92 uncatalogued facts went unread until the money was spent.
 *
 * - catalogueCoverage: which keyed facts the corpus's catalogue names. A fact without an entry
 *   never gets a slot, so only answers find it. Some corpora leave facts out on purpose (the
 *   company drive leaves 12 of 36), so a paid run names them before its first call, and
 *   refuses to start when the catalogue names none.
 * - readableDocuments: how many indexed documents the corpus's reader may read. The
 *   permission graph lives in memory, so a run resumed on an existing database has no
 *   permissions and every search finds nothing; questions are refused then.
 */

import type { Corpus, Engine } from "@inspiration/engine";
import type { Keys } from "./questions.ts";
import { predicateOfFact } from "./reading.ts";

export interface CatalogueCoverage {
  facts: number;
  /** Keyed facts the catalogue has no entry for, sorted. */
  uncatalogued: string[];
}

export function catalogueCoverage(corpus: Pick<Corpus, "vocabulary">, keys: Keys): CatalogueCoverage {
  const catalogued = new Set(corpus.vocabulary?.predicates.map((e) => e.predicate));
  const facts = Object.keys(keys.facts);
  return { facts: facts.length, uncatalogued: facts.filter((f) => !catalogued.has(predicateOfFact(f))).sort() };
}

/** The lines a paid run prints before its first call, and whether it may start. */
export function coverageLines(c: CatalogueCoverage, allowUncatalogued: boolean): { lines: string[]; start: boolean } {
  if (!c.uncatalogued.length) return { lines: [], start: true };
  const covered = c.facts - c.uncatalogued.length;
  const lines = [
    `preflight: ${c.uncatalogued.length} of ${c.facts} keyed facts have no catalogue entry, so no statement of ` +
      `theirs gets a slot and only answers find them (${c.uncatalogued.join(", ")})`,
  ];
  if (covered || allowUncatalogued) return { lines, start: true };
  lines.push(
    "preflight: the catalogue names none of the keyed facts, so governance would decide none of them; add them " +
      "to the corpus's vocabulary.yaml, or pass --allow-uncatalogued to pay for the run anyway",
  );
  return { lines, start: false };
}

export async function readableDocuments(
  engine: Pick<Engine, "retrieval" | "authz">,
  corpus: Pick<Corpus, "reader">,
): Promise<{ indexed: number; readable: number }> {
  const indexed = (await engine.retrieval.documents(corpus.reader.tenant_id)).filter((d) => !d.deleted);
  const decisions = await engine.authz.checkMany(
    corpus.reader,
    "read",
    indexed.map((d) => ({ type: "document", id: d.document })),
  );
  return { indexed: indexed.length, readable: decisions.filter((d) => d.allow).length };
}
