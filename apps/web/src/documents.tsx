// A space's Documents: its sources, their folders and documents, as a list in the centre. It is
// the first look at what a space holds after import; readers find answers by asking.

import type { DocumentEntry, DocumentTreeNode } from "@inspiration/contracts";
import type { Library } from "./api.ts";
import { Crumbs, formatDate } from "./parts.tsx";
import { ReadingSummary, ReadingTag } from "./reading.tsx";
import { Link, type Route } from "./route.tsx";
import { UPLOADS, Uploader } from "./upload.tsx";
import { mayUpload } from "./uploads.ts";
import { type Say, useWords } from "./words.ts";

type DocumentsRoute = Extract<Route, { name: "documents" }>;

/** The node a source and its folder path name, if the reader may see it. */
export function nodeAt(
  sources: readonly DocumentTreeNode[],
  source: string | undefined,
  folders: readonly string[],
): DocumentTreeNode | undefined {
  let node = sources.find((s) => s.source_id === source);
  for (const name of folders) node = node?.children?.find((c) => c.kind === "folder" && c.name === name);
  return node;
}

/** A node's name; the uploads' source is named in the reader's language. */
export const nameOf = (node: DocumentTreeNode, say: Say) =>
  node.kind === "source" && node.source_type === UPLOADS ? say("uploads.name") : node.name;

/** Every document of the library, with where it sits: its space, source and folders. */
export function documentsOf(library: Library, say: Say): { entry: DocumentEntry; where: string[] }[] {
  const out: { entry: DocumentEntry; where: string[] }[] = [];
  const walk = (node: DocumentTreeNode, space: string, source: string) => {
    if (node.document) out.push({ entry: node.document, where: [space, source, ...node.path.slice(0, -1)] });
    for (const c of node.children ?? []) walk(c, space, source);
  };
  for (const space of library.spaces) {
    for (const s of library.trees.get(space.id)?.sources ?? []) walk(s, space.name, nameOf(s, say));
  }
  return out;
}

export function Documents(props: { route: DocumentsRoute; library: Library; onSourcesChanged: () => void }) {
  const { say } = useWords();
  const { route, library } = props;
  const space = library.spaces.find((s) => s.id === route.space);
  const tree = library.trees.get(route.space);
  if (!space || !tree) {
    return (
      <main className="centre">
        <p className="failure">{say("folder.not_found")}</p>
      </main>
    );
  }
  const node = route.source ? nodeAt(tree.sources, route.source, route.folders) : undefined;
  const rows = route.source ? (node?.children ?? []) : tree.sources;
  const top: DocumentsRoute = { name: "documents", space: space.id, folders: [] };
  const source = route.source ? tree.sources.find((s) => s.source_id === route.source) : undefined;
  // Files go into the uploads' folder on screen, else to their root.
  const folder = source?.source_type === UPLOADS ? route.folders : [];
  const list = rows.length === 0 ? <p className="quiet">{say("folder.empty")}</p> : <Rows rows={rows} top={top} />;

  return (
    <main className="centre">
      <Crumbs>
        {[
          <span key="space">{space.name}</span>,
          <Link key="documents" to={top}>
            {say("nav.documents")}
          </Link>,
          source && (
            <Link key="source" to={{ ...top, source: source.source_id }}>
              {nameOf(source, say)}
            </Link>
          ),
          ...route.folders.map((name, i) => (
            <Link key={`folder-${name}`} to={{ ...top, source: route.source, folders: route.folders.slice(0, i + 1) }}>
              {name}
            </Link>
          )),
        ]}
      </Crumbs>
      <h1 className="title">{node ? nameOf(node, say) : say("nav.documents")}</h1>
      <ReadingSummary nodes={node ? [node] : tree.sources} />
      {mayUpload(space) ? (
        <Uploader space={space} sources={tree.sources} folder={folder} onSent={props.onSourcesChanged}>
          {list}
        </Uploader>
      ) : (
        list
      )}
    </main>
  );
}

/** A folder's rows: its folders, with how many documents each holds, and its documents. */
function Rows(props: { rows: DocumentTreeNode[]; top: DocumentsRoute }) {
  const { say, tag } = useWords();
  const { rows, top } = props;
  return (
    <table className="files">
      <thead>
        <tr>
          <th>{say("folder.name")}</th>
          <th>{say("folder.level")}</th>
          <th>{say("folder.modified")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.document ? (
            <tr key={row.document.external_id}>
              <td>
                <Link
                  className="file"
                  to={{
                    name: "document",
                    source: row.source_id,
                    item: row.document.external_id,
                    view: "original",
                  }}
                >
                  {row.name}
                </Link>
                <ReadingTag entry={row.document} />
              </td>
              <td className="quiet">{say(`level.${row.document.governance_level}`)}</td>
              <td className="quiet">{formatDate(tag, row.document.modified_at ?? row.document.fetched_at)}</td>
            </tr>
          ) : (
            <tr key={`${row.kind}-${row.name}`}>
              <td>
                <Link
                  className="folder"
                  to={{
                    ...top,
                    source: row.source_id,
                    folders: row.kind === "folder" ? row.path : [],
                  }}
                >
                  {nameOf(row, say)}
                </Link>
                <span className="quiet count">{say("folder.count", { count: row.document_count ?? 0 })}</span>
              </td>
              <td className="quiet">{row.source_type ? say(`source.${row.source_type}`) : ""}</td>
              <td />
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
