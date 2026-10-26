/**
 * Block identity across versions and the diff between two versions.
 *
 * Parsed files have no block IDs of their own, so a block's first ID comes from its place
 * in the outline and its text (see draftIds). An edited paragraph would then look like one
 * block removed and another added. Alignment repairs that: blocks that kept their ID fix
 * the order of both versions, and in each gap between two such blocks an unmatched block
 * takes the ID of the most similar unmatched block of the same kind in the previous
 * version, when they are similar enough. That block is then "changed", and its unchanged
 * sentences keep their span IDs, so claims citing them keep their evidence.
 *
 * A block also counts as changed when only its context changed: its kind, or the headings
 * above it (a renamed heading, or a paragraph moved under another one). Extraction reads a
 * block with its headings, so what it says may have changed although its text did not.
 */

import type { SourceBlock, Span } from "@inspiration/contracts";

/** Dice similarity of character bigrams at which an edited block counts as the same block. */
export const SAME_BLOCK = 0.5;
/** Gaps larger than this (current times previous blocks) are not aligned; their blocks are new. */
const MAX_GAP_WORK = 250_000;

interface Aligned {
  id: string;
  kind: string;
  text: string;
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = [...text.replace(/\s+/g, "")];
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = (chars[i] as string) + (chars[i + 1] as string);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient of the two texts' character bigrams, 0 to 1. */
export function similarity(a: string, b: string): number {
  return a === b ? 1 : dice(bigrams(a), bigrams(b));
}

function dice(x: ReadonlyMap<string, number>, y: ReadonlyMap<string, number>): number {
  let total = 0;
  let shared = 0;
  for (const n of x.values()) total += n;
  for (const [g, n] of y) {
    total += n;
    shared += Math.min(n, x.get(g) ?? 0);
  }
  return total ? (2 * shared) / total : 0;
}

/** Longest increasing run of previous positions, as indexes into pairs. */
function increasing(pairs: readonly [number, number][]): Set<number> {
  const tails: number[] = [];
  const back: number[] = new Array(pairs.length).fill(-1);
  pairs.forEach(([, j], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] as number] as [number, number])[1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[k] = tails[lo - 1] as number;
    tails[lo] = k;
  });
  const keep = new Set<number>();
  for (let k = tails.at(-1) ?? -1; k >= 0; k = back[k] as number) keep.add(k);
  return keep;
}

/**
 * The current blocks' IDs after alignment with the previous version's blocks. Both lists
 * are in reading order; IDs present in both are kept as they are.
 */
export function align(current: readonly Aligned[], previous: readonly Aligned[]): string[] {
  const ids = current.map((b) => b.id);
  const at = new Map(previous.map((b, j) => [b.id, j]));
  const usedPrev = new Set<number>();
  const pairs: [number, number][] = [];
  current.forEach((b, i) => {
    const j = at.get(b.id);
    if (j !== undefined && !usedPrev.has(j)) {
      usedPrev.add(j);
      pairs.push([i, j]);
    }
  });
  const matchedCur = new Set(pairs.map(([i]) => i));
  const anchors = [...increasing(pairs)].sort((a, b) => a - b).map((k) => pairs[k] as [number, number]);
  const bounds: [number, number][] = [[-1, -1], ...anchors, [current.length, previous.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [ci, pj] = bounds[g] as [number, number];
    const [ce, pe] = bounds[g + 1] as [number, number];
    const cur: number[] = [];
    for (let i = ci + 1; i < ce; i++) if (!matchedCur.has(i)) cur.push(i);
    const prev: number[] = [];
    for (let j = pj + 1; j < pe; j++) if (!usedPrev.has(j)) prev.push(j);
    if (!cur.length || !prev.length || cur.length * prev.length > MAX_GAP_WORK) continue;
    const grams = new Map(prev.map((j) => [j, bigrams((previous[j] as Aligned).text)]));
    // Greedy in reading order, never crossing an earlier match, so the gap stays in order.
    let floor = 0;
    for (const i of cur) {
      const c = current[i] as Aligned;
      const mine = bigrams(c.text);
      let best = -1;
      let bestScore = -1;
      for (let k = floor; k < prev.length; k++) {
        const j = prev[k] as number;
        const p = previous[j] as Aligned;
        if (usedPrev.has(j) || p.kind !== c.kind) continue;
        const score = p.text === c.text ? 1 : dice(mine, grams.get(j) as Map<string, number>);
        if (score > bestScore) {
          best = k;
          bestScore = score;
        }
      }
      if (best < 0 || bestScore < SAME_BLOCK) continue;
      const j = prev[best] as number;
      usedPrev.add(j);
      ids[i] = (previous[j] as Aligned).id;
      floor = best + 1;
    }
  }
  return ids;
}

export interface BlockDiff {
  added_block_ids: string[];
  changed_block_ids: string[];
  removed_block_ids: string[];
  unchanged_block_count: number;
  added_span_ids: string[];
  removed_span_ids: string[];
}

function sameContext(a: SourceBlock, b: SourceBlock): boolean {
  const x = a.heading_path ?? [];
  const y = b.heading_path ?? [];
  return a.kind === b.kind && x.length === y.length && x.every((h, i) => h === y[i]);
}

/** What changed from the previous version's blocks and spans to the current ones. */
export function blockDiff(
  previous: { blocks: readonly SourceBlock[]; spans: readonly Span[] },
  current: { blocks: readonly SourceBlock[]; spans: readonly Span[] },
): BlockDiff {
  const before = new Map(previous.blocks.map((b) => [b.id, b]));
  const after = new Set(current.blocks.map((b) => b.id));
  const diff: BlockDiff = {
    added_block_ids: [],
    changed_block_ids: [],
    removed_block_ids: previous.blocks.filter((b) => !after.has(b.id)).map((b) => b.id),
    unchanged_block_count: 0,
    added_span_ids: [],
    removed_span_ids: [],
  };
  for (const b of current.blocks) {
    const old = before.get(b.id);
    if (!old) diff.added_block_ids.push(b.id);
    else if (old.text_hash !== b.text_hash || !sameContext(old, b)) diff.changed_block_ids.push(b.id);
    else diff.unchanged_block_count++;
  }
  const spansBefore = new Set(previous.spans.map((s) => s.id));
  const spansAfter = new Set(current.spans.map((s) => s.id));
  diff.added_span_ids = current.spans.filter((s) => !spansBefore.has(s.id)).map((s) => s.id);
  diff.removed_span_ids = previous.spans.filter((s) => !spansAfter.has(s.id)).map((s) => s.id);
  return diff;
}
