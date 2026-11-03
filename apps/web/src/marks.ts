// What the Annotated view marks on a document: each passage with the statements that rest
// on it, and where those stand. Pure, so it is tested without a browser.

import type { CellLocation, DocumentView, SearchHit, SourceBlock } from "@inspiration/contracts";

/** A passage as the page shows it: a block, and for a table its rows. */
export interface Passage {
  block: SourceBlock;
  rows: SourceBlock[];
}

/** How a quote reads: an outdated or disputed value, or simply read out of the text. */
export type Tone = "disputed" | "outdated" | "marked";

const RANK: Record<Tone, number> = { disputed: 0, outdated: 1, marked: 2 };

export const toneOf = (statement: SearchHit): Tone =>
  statement.standing === "disputed" || statement.standing === "outdated" ? statement.standing : "marked";

/** The tone that needs the reader most, of all given. */
export const weakest = (tones: readonly Tone[]): Tone | undefined =>
  tones.reduce<Tone | undefined>((w, t) => (w === undefined || RANK[t] < RANK[w] ? t : w), undefined);

export interface Quote {
  text: string;
  tone: Tone;
  cell?: CellLocation;
  row?: string;
}

/** A statement resting on one passage: its quotes there, and what holds in its place. */
export interface Mark {
  statement: SearchHit;
  held?: SearchHit;
  quotes: Quote[];
}

/** Blocks in reading order, with a table's rows inside the table instead of after it. */
export function passages(blocks: readonly SourceBlock[]): Passage[] {
  const tables = new Set(blocks.filter((b) => b.kind === "table").map((b) => b.id));
  const out: Passage[] = [];
  const byId = new Map<string, Passage>();
  for (const block of [...blocks].sort((a, b) => a.ordinal - b.ordinal)) {
    const parent = block.parent_id && tables.has(block.parent_id) ? byId.get(block.parent_id) : undefined;
    if (parent && block.kind === "table_row") {
      parent.rows.push(block);
      continue;
    }
    const passage = { block, rows: [] };
    byId.set(block.id, passage);
    out.push(passage);
  }
  return out;
}

/**
 * The marks on each passage, by the passage's block ID. A statement marks the passages that
 * hold the spans it cites in this version; a table's rows mark the table they sit in.
 */
export function marksOf(view: DocumentView): Map<string, Mark[]> {
  const passageOf = new Map<string, { passage: string; row?: string }>();
  for (const p of passages(view.blocks)) {
    for (const span of p.block.span_ids) passageOf.set(span, { passage: p.block.id });
    for (const row of p.rows)
      for (const span of row.span_ids) passageOf.set(span, { passage: p.block.id, row: row.id });
  }
  const held = new Map(view.annotations.held.map((h) => [h.unit_id, h]));
  const marks = new Map<string, Mark[]>();
  for (const statement of view.annotations.statements) {
    const here = new Map<string, Mark>();
    for (const c of statement.citations) {
      const at = c.source_version_id === view.version.id ? passageOf.get(c.span_id) : undefined;
      if (!at) continue;
      let mark = here.get(at.passage);
      if (!mark) {
        const instead = statement.held_unit_id ? held.get(statement.held_unit_id) : undefined;
        mark = { statement, quotes: [], ...(instead && { held: instead }) };
        here.set(at.passage, mark);
      }
      mark.quotes.push({
        text: c.quote,
        tone: toneOf(statement),
        ...(c.locator?.cell && { cell: c.locator.cell }),
        ...(at.row && { row: at.row }),
      });
    }
    for (const [passage, mark] of here) marks.set(passage, [...(marks.get(passage) ?? []), mark]);
  }
  return marks;
}

/** A text cut into the parts quotes cover, each quote at its first free place, and the parts between. */
export function highlight(text: string, quotes: readonly Quote[]): { text: string; tone?: Tone }[] {
  const ranges: { start: number; end: number; tone: Tone }[] = [];
  // The quotes that need the reader most claim their place first.
  for (const q of [...quotes].sort((a, b) => RANK[a.tone] - RANK[b.tone])) {
    if (!q.text) continue;
    for (let at = text.indexOf(q.text); at >= 0; at = text.indexOf(q.text, at + 1)) {
      const end = at + q.text.length;
      if (!ranges.some((r) => at < r.end && end > r.start)) {
        ranges.push({ start: at, end, tone: q.tone });
        break;
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const out: { text: string; tone?: Tone }[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) out.push({ text: text.slice(at, r.start) });
    out.push({ text: text.slice(r.start, r.end), tone: r.tone });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
