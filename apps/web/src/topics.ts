// A topic as its page shows it: one section per fact with the value that holds and what is
// written against it, then everything else the topic says. Readers see values and where they
// are written, never statements or slots as such.

import type { SearchHit, TopicView } from "@inspiration/contracts";

/** One fact of the page: what holds, and the documents that still say otherwise. */
export interface FactSection {
  slot_key: string;
  label?: string;
  /** The statements of the value that holds; none when the member may not read any. */
  current: SearchHit[];
  /** The other values, each as written, outdated or disputed. */
  against: SearchHit[];
  /** A value stands against the current one until someone decides. */
  disputed: boolean;
}

export interface TopicPage {
  facts: FactSection[];
  /** What the topic says that fills no fact, by document. */
  others: SearchHit[];
  /** How many passages the page cites, and in how many documents. */
  places: number;
  documents: number;
}

const AGAINST = new Set(["outdated", "disputed", "differs"]);

export function pageOf(view: TopicView): TopicPage {
  const held = new Map(view.held.map((h) => [h.unit_id, h]));
  const facts = view.facts.flatMap((fact): FactSection[] => {
    const filled = view.statements.filter((h) => h.slot_key === fact.slot_key);
    if (filled.length === 0) return [];
    const against = filled.filter((h) => h.standing && AGAINST.has(h.standing));
    let current = filled.filter((h) => !against.includes(h));
    // The value that holds may be written only outside the topic; show it as search found it.
    if (current.length === 0) {
      const ids = [...new Set(against.flatMap((h) => h.held_unit_id ?? []))];
      current = ids.flatMap((id) => held.get(id) ?? []);
    }
    return [
      {
        slot_key: fact.slot_key,
        ...(fact.label && { label: fact.label }),
        current,
        against,
        disputed: against.some((h) => h.standing === "disputed"),
      },
    ];
  });
  const others = view.statements
    .filter((h) => !h.slot_key)
    .sort((a, b) => a.title.localeCompare(b.title) || a.unit_id.localeCompare(b.unit_id));
  const shown = [...facts.flatMap((f) => [...f.current, ...f.against]), ...others];
  const cited = shown.flatMap((h) => h.citations);
  return {
    facts,
    others,
    places: new Set(cited.map((c) => c.span_id)).size,
    documents: new Set(cited.map((c) => c.source_version_id)).size,
  };
}
