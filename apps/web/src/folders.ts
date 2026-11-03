// A space's folders as its maintainer sees them: the documents each holds directly and the
// governance level they are read at. The level is written on the folder and its documents
// follow it; a document set on its own is named, so a folder of hundreds stays one row.

import type { DocumentEntry, DocumentTree, DocumentTreeNode, GovernanceLevel } from "@inspiration/contracts";

export interface FolderRow {
  source_id: string;
  source: string;
  /** The folders from the source's root; empty for the documents at the root. */
  path: string[];
  documents: DocumentEntry[];
  /** The level most of its documents are read at. */
  level: GovernanceLevel;
  /** Its documents read at another level. */
  own: DocumentEntry[];
}

const ORDER: GovernanceLevel[] = ["governed", "reference", "search_only"];

export function folderRows(tree: DocumentTree): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (node: DocumentTreeNode, source: DocumentTreeNode) => {
    const documents = (node.children ?? []).flatMap((c) => c.document ?? []);
    if (documents.length) rows.push(rowOf(source, node.path, documents));
    for (const c of node.children ?? []) if (c.kind === "folder") walk(c, source);
  };
  for (const source of tree.sources) walk(source, source);
  return rows;
}

function rowOf(source: DocumentTreeNode, path: string[], documents: DocumentEntry[]): FolderRow {
  const count = (level: GovernanceLevel) => documents.filter((d) => d.governance_level === level).length;
  // The most common level; on a tie, the one that governs more.
  const level = ORDER.reduce((a, b) => (count(b) > count(a) ? b : a));
  return {
    source_id: source.source_id,
    source: source.name,
    path,
    documents,
    level,
    own: documents.filter((d) => d.governance_level !== level),
  };
}
