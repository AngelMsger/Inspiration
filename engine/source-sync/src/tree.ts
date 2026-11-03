import type { DocumentEntry, DocumentTreeNode, Source, SourceVersion } from "@inspiration/contracts";

/** A document as the tree lists it, from its latest stored version. */
export function entryOf(version: SourceVersion): DocumentEntry {
  return {
    source_id: version.source_id,
    external_id: version.external_id,
    title: version.title,
    source_version_id: version.id,
    // Versions written before levels have none and count as governed (SourceVersion).
    governance_level: version.governance_level ?? "governed",
    approval_state: version.approval_state,
    mime_type: version.mime_type,
    ...(version.language && { language: version.language }),
    ...(version.metadata?.modified_at && { modified_at: version.metadata.modified_at }),
    fetched_at: version.fetched_at,
  };
}

/** The folders from a source's root to a document: the source's own path, else its external ID's. */
export function foldersOf(version: SourceVersion): string[] {
  if (version.metadata?.path) return [...version.metadata.path];
  const parts = version.external_id.split("/");
  return parts.length > 1 ? parts.slice(0, -1) : [];
}

/**
 * One node per source, with its folders and documents: folders first, then documents, each
 * by name. Only the documents given are placed, so a folder with none of them is never built.
 */
export function documentTree(
  sources: readonly Source[],
  documents: readonly { version: SourceVersion; entry: DocumentEntry }[],
): DocumentTreeNode[] {
  const roots = new Map<string, DocumentTreeNode>();
  for (const s of sources) {
    roots.set(s.id, {
      kind: "source",
      name: s.name,
      source_id: s.id,
      source_type: s.type,
      path: [],
      document_count: 0,
      children: [],
    });
  }
  for (const { version, entry } of documents) {
    const root = roots.get(version.source_id);
    if (!root) continue;
    let node = root;
    const path: string[] = [];
    for (const name of foldersOf(version)) {
      path.push(name);
      node.document_count = (node.document_count ?? 0) + 1;
      const children = node.children ?? [];
      let next = children.find((c) => c.kind === "folder" && c.name === name);
      if (!next) {
        next = { kind: "folder", name, source_id: root.source_id, path: [...path], document_count: 0, children: [] };
        children.push(next);
        node.children = children;
      }
      node = next;
    }
    node.document_count = (node.document_count ?? 0) + 1;
    node.children = [
      ...(node.children ?? []),
      { kind: "document", name: entry.title, source_id: root.source_id, path: [...path, entry.title], document: entry },
    ];
  }
  const order = (a: DocumentTreeNode, b: DocumentTreeNode) =>
    Number(a.kind === "document") - Number(b.kind === "document") || a.name.localeCompare(b.name);
  const sort = (node: DocumentTreeNode): DocumentTreeNode =>
    node.children ? { ...node, children: node.children.map(sort).sort(order) } : node;
  return [...roots.values()].map(sort);
}
