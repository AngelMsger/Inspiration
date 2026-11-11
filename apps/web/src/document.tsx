// Reading a document: the Original view as its author wrote it, the Annotated view with what
// the engine read out of each passage and where its values stand. The right panel is about the
// selected passage only.

import type { DocumentView, SourceBlock } from "@inspiration/contracts";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, type Library, useLoad } from "./api.ts";
import { documentsOf } from "./documents.tsx";
import { citedAt, remember } from "./home.tsx";
import { highlight, type Mark, marksOf, type Passage, passages, type Quote, weakest } from "./marks.ts";
import { Crumbs, Failure, formatDate, Standing } from "./parts.tsx";
import type { Person } from "./people.ts";
import { stateOf } from "./reading.ts";
import { ReadingNote } from "./reading.tsx";
import { type DocumentRoute, Link, navigate } from "./route.tsx";
import { NewVersion, UPLOADS } from "./upload.tsx";
import { mayUpload } from "./uploads.ts";
import { useWords } from "./words.ts";

export function DocumentScreen(props: {
  route: DocumentRoute;
  library: Library;
  person: Person;
  onSourcesChanged: () => void;
}) {
  const { say } = useWords();
  const { route } = props;
  // A new version is read again; the documents list follows.
  const [versions, setVersions] = useState(0);
  const key = route.version ?? `${route.source}|${route.item}`;
  // While the engine reads the latest version, the library follows it; the document is opened
  // again each time its reading state changes, and the one opened before stays on screen meanwhile.
  const entry = route.version
    ? undefined
    : documentsOf(props.library, say).find(
        (d) => d.entry.source_id === route.source && d.entry.external_id === route.item,
      )?.entry;
  const loaded = useLoad(`document:${key}:${versions}:${entry ? stateOf(entry) : "read"}`, () => api.document(route));
  const last = useRef<{ key: string; view: DocumentView }>(undefined);
  if (loaded.state === "done") last.current = { key, view: loaded.value };
  const view =
    loaded.state === "done"
      ? loaded.value
      : loaded.state === "loading" && last.current?.key === key
        ? last.current.view
        : undefined;
  if (!view) {
    return (
      <main className="reading">
        {loaded.state === "failed" ? (
          <Failure error={loaded.error} notFound={say("doc.not_found")} />
        ) : (
          <p className="quiet">{say("doc.reading")}</p>
        )}
      </main>
    );
  }
  const changed = () => {
    setVersions((n) => n + 1);
    props.onSourcesChanged();
  };
  return <Reading {...props} view={view} onNewVersion={changed} />;
}

function Reading(props: {
  route: DocumentRoute;
  library: Library;
  person: Person;
  view: DocumentView;
  onNewVersion: () => void;
}) {
  const { say, tag } = useWords();
  const { route, view, library, person } = props;
  const list = useMemo(() => passages(view.blocks), [view]);
  const marks = useMemo(() => marksOf(view), [view]);
  const annotated = route.view === "annotated";
  const selected = list.find((p) =>
    route.block
      ? p.block.id === route.block
      : route.span && [p.block, ...p.rows].some((b) => b.span_ids.includes(route.span as string)),
  );
  const space = library.spaces.find((s) => s.id === view.space_id);
  // Only an uploaded document takes a new version here; a connected source brings its own.
  const uploaded = library.trees
    .get(view.space_id ?? "")
    ?.sources.some((s) => s.source_id === view.document.source_id && s.source_type === UPLOADS);
  // The uploads' name is stored in English; the reader sees it in their language.
  const sourceName = uploaded ? say("uploads.name") : view.source_name;
  const outdated = view.annotations.statements.filter((s) => s.standing === "outdated").length;

  useEffect(() => {
    remember(person.member, {
      title: view.document.title,
      where: [space?.name, sourceName].filter(Boolean).join(" · "),
      source: view.document.source_id,
      item: view.document.external_id,
    });
  }, [person.member, view, space, sourceName]);
  // Arriving from a citation brings the cited passage into view; a click leaves the page still.
  const cited = route.span ? selected?.block.id : undefined;
  useEffect(() => {
    if (cited) document.getElementById(cited)?.scrollIntoView({ block: "center" });
  }, [cited]);

  const select = (block: string | undefined) => navigate({ ...route, block, span: undefined }, { replace: true });
  const top = { name: "documents" as const, space: view.space_id ?? "", folders: [] };
  const folders = view.path ?? [];

  return (
    <div className="with-panel">
      <main className="reading">
        <div className="reading-head">
          <Crumbs back={route.from && <Link to={{ name: "ask", q: route.from }}>← {say("doc.back")}</Link>}>
            {[
              space && <span key="space">{space.name}</span>,
              space && (
                <Link key="documents" to={top}>
                  {say("nav.documents")}
                </Link>
              ),
              space && (
                <Link key="source" to={{ ...top, source: view.document.source_id }}>
                  {sourceName}
                </Link>
              ),
              ...folders.map((name, i) => (
                <Link
                  key={`f-${name}`}
                  to={{ ...top, source: view.document.source_id, folders: folders.slice(0, i + 1) }}
                >
                  {name}
                </Link>
              )),
              <span key="title">{view.document.title}</span>,
            ]}
          </Crumbs>
          <span className="grow" />
          <div role="tablist" aria-label={say("doc.views")} className="tabs">
            {(["original", "annotated"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={route.view === v}
                onClick={() => navigate({ ...route, view: v }, { replace: true })}
              >
                {say(`doc.${v}`)}
              </button>
            ))}
          </div>
        </div>
        <article className="paper">
          <h1>{view.document.title}</h1>
          <div className="meta">
            <span>{[sourceName, ...folders].join(" · ")}</span>
            {view.document.url && /^https?:\/\//i.test(view.document.url) && (
              <a href={view.document.url} target="_blank" rel="noopener noreferrer">
                {say("doc.open_source")}
              </a>
            )}
            <span>{say("doc.level", { level: say(`level.${view.document.governance_level}`) })}</span>
            <span>{say("doc.synced", { date: formatDate(tag, view.document.fetched_at) })}</span>
            {uploaded && space && mayUpload(space) && !route.version && (
              <NewVersion space={space.id} path={view.document.external_id} onChanged={props.onNewVersion} />
            )}
            {annotated && (
              <span>
                {say("doc.summary", { statements: view.annotations.statements.length })}
                {outdated > 0 && (
                  <span className="standing standing-outdated">{say("doc.outdated", { count: outdated })}</span>
                )}
              </span>
            )}
          </div>
          <ReadingNote entry={view.document} />
          {list
            .filter((p, i) => !(i === 0 && p.block.kind === "heading" && p.block.text === view.document.title))
            .map((p) => (
              <PassageView
                key={p.block.id}
                passage={p}
                marks={annotated ? marks.get(p.block.id) : undefined}
                selected={selected?.block.id === p.block.id}
                onSelect={() => select(selected?.block.id === p.block.id ? undefined : p.block.id)}
              />
            ))}
        </article>
      </main>
      {selected && (
        <PassagePanel
          passage={selected}
          marks={marks.get(selected.block.id)}
          from={route.from}
          onClose={() => select(undefined)}
        />
      )}
    </div>
  );
}

function PassageView(props: { passage: Passage; marks: Mark[] | undefined; selected: boolean; onSelect: () => void }) {
  const { block, rows } = props.passage;
  if (block.kind === "heading") {
    const level = Math.min(Math.max((block.level ?? 1) + 1, 2), 4);
    const Heading = `h${level}` as "h2" | "h3" | "h4";
    return <Heading id={block.id}>{block.text}</Heading>;
  }
  const quotes = (props.marks ?? []).flatMap((m) => m.quotes);
  const standing = weakest(quotes.map((q) => q.tone));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onSelect();
    }
  };
  let body: ReactNode;
  if (block.kind === "table") body = <Table block={block} rows={rows} quotes={quotes} />;
  else {
    // Each part is keyed by where it starts in the text.
    let start = 0;
    body = highlight(block.text, quotes).map((part) => {
      const at = start;
      start += part.text.length;
      return part.tone ? (
        <mark key={at} className={`tone-${part.tone}`}>
          {part.text}
        </mark>
      ) : (
        <span key={at}>{part.text}</span>
      );
    });
  }
  return (
    // A table cannot sit inside a button, so a passage is a focusable region that acts as one.
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      id={block.id}
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      className={`passage passage-${block.kind}${standing ? ` passage-${standing}` : ""}${props.selected ? " passage-selected" : ""}`}
      onClick={props.onSelect}
      onKeyDown={onKeyDown}
    >
      {body}
    </div>
  );
}

function Table(props: { block: SourceBlock; rows: SourceBlock[]; quotes: Quote[] }) {
  const head = Number(props.block.attrs?.header_rows ?? 0);
  // A quote names its cell where the source says; otherwise it marks the cells holding its text.
  const toneAt = (row: SourceBlock, col: number, text: string) =>
    weakest(
      props.quotes
        .filter((q) => q.row === row.id && (q.cell ? q.cell.col === col : text.includes(q.text)))
        .map((q) => q.tone),
    );
  const line = (row: SourceBlock, Cell: "th" | "td") => (
    <tr key={row.id}>
      {row.text.split("\t").map((text, col) => {
        const tone = toneAt(row, col, text);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells, in order
          <Cell key={col}>{tone ? <mark className={`tone-${tone}`}>{text}</mark> : text}</Cell>
        );
      })}
    </tr>
  );
  return (
    <table>
      {head > 0 && <thead>{props.rows.slice(0, head).map((r) => line(r, "th"))}</thead>}
      <tbody>{props.rows.slice(head).map((r) => line(r, "td"))}</tbody>
    </table>
  );
}

function PassagePanel(props: { passage: Passage; marks: Mark[] | undefined; from?: string; onClose: () => void }) {
  const { say } = useWords();
  const text = props.passage.block.text.replace(/\s+/g, " ");
  return (
    <aside className="panel" aria-label={say("doc.passage")}>
      <div className="panel-head">
        <span className="panel-title">{say("doc.passage")}</span>
        <button type="button" className="plain" onClick={props.onClose} aria-label={say("doc.close")}>
          ×
        </button>
      </div>
      <p className="quiet excerpt">{text.length > 80 ? `${text.slice(0, 80)}…` : text}</p>
      <h3>{say("doc.says")}</h3>
      {props.marks?.length ? (
        <ul className="statements">
          {props.marks.map((m) => (
            <li key={m.statement.unit_id}>
              <Standing value={m.statement.standing} />
              <p>{m.statement.snippet}</p>
              {m.held && (
                <div className="held">
                  <div className="label">{say("doc.holds_instead")}</div>
                  <p>{m.held.snippet}</p>
                  {m.held.citations[0] && (
                    <Link to={citedAt(m.held.citations[0], props.from)}>
                      {say("doc.from", { title: m.held.title })}
                    </Link>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">{say("doc.none")}</p>
      )}
    </aside>
  );
}
