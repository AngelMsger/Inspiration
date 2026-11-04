// Maintaining a space, which only its owner enters: an overview of what is waiting in it and
// how its documents stand, its topics with their owners, and its folders with the governance
// level each is read at. The left column turns blue there, so maintaining never looks like
// reading. Levels and owners are shown, not changed: changing them is a batch change, later.

import type { SpaceChange, SpaceOverview, SyncReport, TaxonomyNode } from "@inspiration/contracts";
import { type ReactNode, useRef, useState } from "react";
import { api, failureOf, type Library, type Loaded, useLoad } from "./api.ts";
import type { Person } from "./backend.ts";
import { folderRows } from "./folders.ts";
import { Crumbs, Failure, formatDate } from "./parts.tsx";
import { Link, type Route } from "./route.tsx";
import type { Update } from "./updates.ts";
import { useWords } from "./words.ts";

export type MaintainRoute = Extract<Route, { name: "maintain" }>;
export type MaintainPage = MaintainRoute["page"];

const nameOf = (people: Person[], member: string | undefined) => people.find((p) => p.member === member)?.name;

/** The left column while maintaining a space. */
export function MaintainColumn(props: { route: MaintainRoute; library: Library }) {
  const { say } = useWords();
  const space = props.library.spaces.find((s) => s.id === props.route.space);
  const item = (page: MaintainPage, label: string) => (
    <Link
      to={{ name: "maintain", space: props.route.space, page }}
      className="nav-item"
      current={props.route.page === page}
    >
      {label}
    </Link>
  );
  return (
    <nav className="left left-maintain" aria-label={say("maintain.title")}>
      <div className="maintain-head">
        <span className="quiet">{say("maintain.title")}</span>
        <b>{space?.name}</b>
        <Link to={{ name: "topics", space: props.route.space }} className="maintain-back">
          {say("maintain.back")}
        </Link>
      </div>
      {item("overview", say("maintain.overview"))}
      <div className="nav-heading">{say("maintain.structure")}</div>
      {item("topics", say("maintain.topics"))}
      {item("documents", say("maintain.documents"))}
    </nav>
  );
}

export function MaintainScreen(props: {
  route: MaintainRoute;
  library: Library;
  people: Person[];
  /** Changes when a todo is resolved or a source is synced, so the overview is read again. */
  version: number;
  onSourcesChanged: () => void;
}) {
  const { say } = useWords();
  const { route } = props;
  const loaded = useLoad(`overview:${route.space}:${props.version}`, () => api.overview(route.space));
  // Read again after a change, it stays on screen meanwhile, and so does the demo panel.
  const last = useRef<SpaceOverview>(undefined);
  if (loaded.state === "done") last.current = loaded.value;
  const overview: Loaded<SpaceOverview> =
    last.current?.space.id === route.space ? { state: "done", value: last.current } : loaded;
  const space = props.library.spaces.find((s) => s.id === route.space);
  const page = say(`maintain.${route.page}`);
  const crumbs = <Crumbs>{[say("maintain.title"), space?.name, page]}</Crumbs>;
  if (overview.state !== "done") {
    return (
      <main className="centre">
        {crumbs}
        {overview.state === "failed" ? (
          <Failure error={overview.error} notFound={say("space.not_found")} />
        ) : (
          <p className="quiet">{say("space.loading")}</p>
        )}
      </main>
    );
  }
  const owner = nameOf(props.people, overview.value.space.owner_id);
  const heading = (
    <div className="heading">
      <h1 className="title">{route.page === "overview" ? space?.name : page}</h1>
      {owner && <span className="quiet">{say("space.owner", { name: owner })}</span>}
    </div>
  );
  switch (route.page) {
    case "overview":
      return (
        <div className="with-panel">
          <main className="centre">
            {crumbs}
            {heading}
            <Overview overview={overview.value} />
          </main>
          <DemoPanel changes={overview.value.changes} onApplied={props.onSourcesChanged} />
        </div>
      );
    case "topics":
      return (
        <main className="centre">
          {crumbs}
          {heading}
          <Topics topics={props.library.topics.get(route.space)?.topics ?? []} people={props.people} />
        </main>
      );
    case "documents":
      return (
        <main className="centre">
          {crumbs}
          {heading}
          <Folders library={props.library} space={route.space} overview={overview.value} />
        </main>
      );
  }
}

function Metric(props: { label: string; value: number; children?: ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.children && <div className="metric-sub">{props.children}</div>}
    </div>
  );
}

function Overview(props: { overview: SpaceOverview }) {
  const { say, tag } = useWords();
  const { overview } = props;
  const work = overview.work.reduce((n, w) => n + w.count, 0);
  const facts = overview.disputed.map((d) => d.label ?? d.slot_key);
  const latest = overview.changes.find((c) => c.kind === "updated") ?? overview.changes[0];
  const summary = [
    work ? say("space.summary_work", { count: work }) : say("space.summary_quiet"),
    facts.length > 0 && say("space.summary_disputed", { facts: facts.join(say("list.mark")) }),
    latest &&
      say(latest.kind === "updated" ? "space.summary_updated" : "space.summary_added", {
        title: latest.document.title,
        when: formatDate(tag, latest.document.fetched_at, true),
      }),
  ].filter(Boolean);
  const counts = Object.fromEntries(overview.levels.map((l) => [l.level, l.documents]));
  return (
    <>
      <div className="metrics">
        <Metric label={say("space.work")} value={work}>
          {overview.work.map((w) => `${say(`todo.${w.kind}`)} ${w.count}`).join(" · ")}
          {overview.unassigned > 0 && <div>{say("space.unassigned", { count: overview.unassigned })}</div>}
        </Metric>
        <Metric label={say("space.disputed")} value={facts.length}>
          {facts.join(say("list.mark"))}
        </Metric>
        <Metric label={say("space.documents")} value={overview.documents}>
          {say("space.levels", counts)}
        </Metric>
      </div>
      <p className="summary">{summary.join("")}</p>
      {work > 0 && (
        <Link to={{ name: "inbox" }} className="secondary">
          {say("space.to_inbox")}
        </Link>
      )}
      <h2 className="section">{say("space.changes")}</h2>
      <ul className="rows changes">
        {overview.changes.map((c) => (
          <li key={`${c.document.source_id}:${c.document.external_id}`}>
            <Link
              to={{
                name: "document",
                source: c.document.source_id,
                item: c.document.external_id,
                view: "annotated",
              }}
            >
              {c.document.title}
            </Link>
            <span className={`kind kind-${c.kind}`}>{say(`space.change_${c.kind}`)}</span>
            <span className="quiet when">{formatDate(tag, c.document.fetched_at, true)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Topics(props: { topics: TaxonomyNode[]; people: Person[] }) {
  const { say } = useWords();
  const under = (parent: string | undefined) =>
    props.topics
      .filter((t) => t.parent_key === parent)
      .sort((a, b) => a.ordinal - b.ordinal || a.key.localeCompare(b.key));
  const rows = (parent: string | undefined, depth: number): ReactNode[] =>
    under(parent).flatMap((t) => [
      <tr key={t.key}>
        <td style={{ paddingLeft: 8 + depth * 20 }}>
          <Link to={{ name: "topic", key: t.key }}>{t.title}</Link>
        </td>
        <td className="quiet">{say("space.statements", { count: t.statement_count ?? 0 })}</td>
        <td>{nameOf(props.people, t.owner_id) ?? <span className="quiet">{say("space.no_owner")}</span>}</td>
      </tr>,
      ...rows(t.key, depth + 1),
    ]);
  return (
    <>
      <p className="summary">{say("space.topics_about", { count: props.topics.length })}</p>
      <table className="files">
        <thead>
          <tr>
            <th>{say("space.head_topic")}</th>
            <th>{say("space.head_size")}</th>
            <th>{say("space.head_owner")}</th>
          </tr>
        </thead>
        <tbody>{rows(undefined, 0)}</tbody>
      </table>
    </>
  );
}

function Folders(props: { library: Library; space: string; overview: SpaceOverview }) {
  const { say } = useWords();
  const tree = props.library.trees.get(props.space);
  const folders = tree ? folderRows(tree) : [];
  const updated = props.overview.changes.filter((c) => c.kind === "updated").length;
  const counts = Object.fromEntries(props.overview.levels.map((l) => [l.level, l.documents]));
  return (
    <>
      <div className="metrics">
        <Metric label={say("space.documents")} value={props.overview.documents}>
          {say("space.levels", counts)}
        </Metric>
        <Metric label={say("space.updated")} value={updated} />
      </div>
      <p className="summary">{say("space.levels_about")}</p>
      <table className="files">
        <thead>
          <tr>
            <th>{say("space.head_folder")}</th>
            <th>{say("space.head_source")}</th>
            <th>{say("space.head_documents")}</th>
            <th>{say("space.head_level")}</th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <tr key={`${f.source_id}/${f.path.join("/")}`}>
              <td>
                <Link
                  to={{ name: "documents", space: props.space, source: f.source_id, folders: f.path }}
                  className="folder"
                >
                  {f.path.join(" / ") || say("space.top_level")}
                </Link>
              </td>
              <td className="quiet">{f.source}</td>
              <td>{f.documents.length}</td>
              <td>
                {say(`level.${f.level}`)}
                {f.own.map((d) => (
                  <div key={d.external_id} className="quiet">
                    {say("space.own", { title: d.title, level: say(`level.${d.governance_level}`) })}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The demo's upstream edits: put a prepared new version into a source and watch the engine
 * read it, then go where it shows: the new versions' marks, the update's question, the inbox.
 */
function DemoPanel(props: { changes: SpaceChange[]; onApplied: () => void }) {
  const { say } = useWords();
  const [changes, setChanges] = useState(0);
  const loaded = useLoad(`updates:${changes}`, api.updates);
  const updates = useRef<Update[]>([]);
  if (loaded.state === "done") updates.current = loaded.value.updates;
  const [busy, setBusy] = useState<string>();
  const [done, setDone] = useState<{ update: Update; report: SyncReport }>();
  const [failure, setFailure] = useState<ReturnType<typeof failureOf>>();
  if (updates.current.length === 0) return null;
  const put = (update: Update) => {
    setBusy(update.name);
    setFailure(undefined);
    api.putUpdate(update.name).then(
      (report) => {
        setBusy(undefined);
        setDone({ update, report });
        setChanges((n) => n + 1);
        props.onApplied();
      },
      (e: unknown) => {
        setBusy(undefined);
        setFailure(failureOf(e));
      },
    );
  };
  return (
    <aside className="panel panel-demo" aria-label={say("demo.title")}>
      <div className="demo-card">
        <div className="demo-head">
          <span className="kind">{say("demo.tag")}</span>
          <span className="panel-title">{say("demo.title")}</span>
        </div>
        <p className="excerpt">{say("demo.about")}</p>
        {updates.current.map((u) => (
          <div key={u.name} className="demo-update">
            <div className="demo-file">
              <b>{u.title}</b>
              <span className="quiet">{say(u.applied ? "demo.file_in" : "demo.file")}</span>
            </div>
            <button
              type="button"
              className={busy === u.name ? "primary demo-busy" : "primary"}
              disabled={u.applied || busy !== undefined}
              onClick={() => put(u)}
            >
              {busy === u.name ? say("demo.putting") : u.applied ? say("demo.applied") : say("demo.put")}
            </button>
          </div>
        ))}
        {done && <Done {...done} changes={props.changes} />}
        {failure && <Failure error={failure} />}
      </div>
    </aside>
  );
}

/** What the engine read, and where to see it: the changes come newest first. */
function Done(props: { update: Update; report: SyncReport; changes: SpaceChange[] }) {
  const { say } = useWords();
  const count = props.report.outcomes.updated + props.report.outcomes.created;
  return (
    <div className="demo-done" role="status">
      <p>{say("demo.done", { title: props.update.title, count })}</p>
      <ul className="demo-next">
        {props.changes.slice(0, count).map((c) => (
          <li key={`${c.document.source_id}:${c.document.external_id}`}>
            <Link
              to={{ name: "document", source: c.document.source_id, item: c.document.external_id, view: "annotated" }}
            >
              {say("inbox.see_marks", { title: c.document.title })}
            </Link>
          </li>
        ))}
        {props.update.question && (
          <li>
            <Link to={{ name: "ask", q: props.update.question }}>
              {say("demo.ask", { question: props.update.question })}
            </Link>
          </li>
        )}
        <li>
          <Link to={{ name: "inbox" }}>{say("space.to_inbox")}</Link>
        </li>
      </ul>
    </div>
  );
}
