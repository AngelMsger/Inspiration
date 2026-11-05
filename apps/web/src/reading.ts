// How far the engine has read a space's documents, as the page follows it. A space with
// documents waiting or being read has its Documents tree asked for again, after a growing wait,
// until none is. Paused reading is not followed: the engine carries it on by itself, often the
// next day, and the page shows it as paused until it is read again.

import type {
  DocumentEntry,
  DocumentTree,
  DocumentTreeNode,
  ReadingCounts,
  ReadingState,
} from "@inspiration/contracts";

/** A document's reading state; one the engine says nothing about is read. */
export const stateOf = (entry: DocumentEntry): ReadingState => entry.reading?.state ?? "read";

/** The documents in and below `nodes` by reading state. */
export function countsOf(nodes: readonly DocumentTreeNode[]): ReadingCounts {
  const counts: ReadingCounts = { waiting: 0, reading: 0, read: 0, paused: 0, failed: 0 };
  const walk = (n: DocumentTreeNode) => {
    if (n.document) counts[stateOf(n.document)]++;
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of nodes) walk(n);
  return counts;
}

/** Whether the engine is still reading some of a tree's documents, so the tree is worth asking for again. */
export const going = (tree: DocumentTree) => (tree.reading?.waiting ?? 0) + (tree.reading?.reading ?? 0) > 0;

/** The wait before asking again: two seconds, half as long again each time, at most half a minute. */
export const delayOf = (attempt: number) => Math.min(30_000, 2000 * 1.5 ** attempt);

/**
 * Asks for the trees of `spaces` again until none has documents waiting or being read, and tells
 * `onTree` each tree that came back; a tree that could not be read is asked for again. Answers
 * true once every space settled, false when `signal` stopped it first.
 */
export async function follow(
  spaces: readonly string[],
  tree: (space: string) => Promise<DocumentTree>,
  onTree: (tree: DocumentTree) => void,
  options: { signal: AbortSignal; wait?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const { signal, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  let left = [...spaces];
  for (let attempt = 0; left.length > 0; attempt++) {
    await wait(delayOf(attempt));
    if (signal.aborted) return false;
    const trees = await Promise.all(left.map((s) => tree(s).catch(() => undefined)));
    if (signal.aborted) return false;
    for (const t of trees) if (t) onTree(t);
    left = left.filter((_, i) => {
      const t = trees[i];
      return !t || going(t);
    });
  }
  return true;
}
