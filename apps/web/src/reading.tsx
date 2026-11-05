// How reading a space's documents goes, on screen: a tag on each document not read yet, a line
// counting them above the list, a note on the document itself, and the library followed while the
// engine reads (reading.ts).

import type { DocumentEntry, DocumentTree, DocumentTreeNode } from "@inspiration/contracts";
import { useEffect, useMemo, useState } from "react";
import { api, type Library } from "./api.ts";
import { countsOf, follow, going, stateOf } from "./reading.ts";
import { useWords } from "./words.ts";

/**
 * The library with the trees of spaces still being read as they come back while the engine
 * reads; once every one settled, `onSettled` hears it, so the whole library is read again, since
 * reading changes the knowledge as well as the documents.
 */
export function useFollowed(library: Library | undefined, onSettled: () => void): Library | undefined {
  const [fresh, setFresh] = useState<{ of: Library; trees: Map<string, DocumentTree> }>();
  useEffect(() => {
    if (!library) return;
    const spaces = [...library.trees.values()].filter(going).map((t) => t.space_id);
    if (spaces.length === 0) return;
    const stop = new AbortController();
    const onTree = (tree: DocumentTree) =>
      setFresh((f) => ({ of: library, trees: new Map(f?.of === library ? f.trees : []).set(tree.space_id, tree) }));
    void follow(spaces, (s) => api.tree(s), onTree, { signal: stop.signal }).then((settled) => settled && onSettled());
    return () => stop.abort();
  }, [library, onSettled]);
  return useMemo(
    () =>
      library && fresh?.of === library ? { ...library, trees: new Map([...library.trees, ...fresh.trees]) } : library,
    [library, fresh],
  );
}

/** A document's reading state beside its name, unless it is read; the engine's note is its detail. */
export function ReadingTag(props: { entry: DocumentEntry }) {
  const { say } = useWords();
  const state = stateOf(props.entry);
  if (state === "read") return null;
  return (
    <span className={`reading-tag reading-${state}`} title={props.entry.reading?.note}>
      {say(`reading.${state}`)}
    </span>
  );
}

/** How many of the documents in and below `nodes` are not read yet. */
export function ReadingSummary(props: { nodes: readonly DocumentTreeNode[] }) {
  const { say } = useWords();
  const counts = countsOf(props.nodes);
  const shown = (["reading", "waiting", "paused", "failed"] as const).filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <p className="reading-summary quiet" aria-live="polite">
      <span>{shown.map((s) => say(`reading.count.${s}`, { count: counts[s] })).join(say("list.mark"))}</span>
      {counts.paused > 0 && <span>{say("reading.paused_hint")}</span>}
    </p>
  );
}

/** What a document's reading means for the reader, unless it is read; the engine's note is its detail. */
export function ReadingNote(props: { entry: DocumentEntry }) {
  const { say } = useWords();
  const state = stateOf(props.entry);
  if (state === "read") return null;
  return (
    <div className={`reading-note reading-${state}`} role="status">
      <p>{say(`reading.doc.${state}`)}</p>
      {props.entry.reading?.note && <p className="quiet reading-detail">{props.entry.reading.note}</p>}
    </div>
  );
}
