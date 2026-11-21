// The documents and knowledge outlines can be explored without opening their nodes.
import type { DocumentTreeNode, TaxonomyNode } from "@inspiration/contracts";
import { type ReactNode, useEffect, useState } from "react";
import type { Library } from "./api.ts";
import { nameOf } from "./documents.tsx";
import type { Person } from "./people.ts";
import { href, Link, type Route } from "./route.tsx";
import { useWords } from "./words.ts";

function Branch(props: { to: Route; label: string; active: boolean; contains: boolean; children?: ReactNode }) {
  const { say } = useWords();
  const key = `inspiration.tree:${href(props.to)}`;
  const [open, setOpen] = useState(() => {
    try {
      return props.contains || localStorage.getItem(key) === "open";
    } catch {
      return props.contains;
    }
  });
  useEffect(() => {
    if (props.contains) setOpen(true);
  }, [props.contains]);
  const toggle = () =>
    setOpen((value) => {
      try {
        localStorage.setItem(key, value ? "closed" : "open");
      } catch {
        /* Optional preference. */
      }
      return !value;
    });
  return (
    <li>
      <div className="tree-row">
        {props.children ? (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={open}
            aria-label={say("nav.expand", { name: props.label })}
            onClick={toggle}
          >
            {open ? "⌄" : "›"}
          </button>
        ) : (
          <span className="tree-leaf" />
        )}
        <Link to={props.to} current={props.active}>
          {props.label}
        </Link>
      </div>
      {props.children && open && <ul>{props.children}</ul>}
    </li>
  );
}

export function Navigation(props: { route: Route; library: Library; person: Person; todos: number }) {
  const { say } = useWords();
  const { library, route } = props;
  const documents = (node: DocumentTreeNode, space: string): ReactNode => {
    const doc = node.document;
    const to: Route = doc
      ? { name: "document", source: doc.source_id, item: doc.external_id, view: "annotated" }
      : { name: "documents", space, source: node.source_id, folders: node.kind === "folder" ? node.path : [] };
    const active = doc
      ? route.name === "document" && route.source === doc.source_id && route.item === doc.external_id
      : route.name === "documents" &&
        route.space === space &&
        route.source === node.source_id &&
        route.folders.join("/") === (node.kind === "folder" ? node.path.join("/") : "");
    const contains = (n: DocumentTreeNode): boolean =>
      !!(
        n.document &&
        route.name === "document" &&
        (n.document.source_version_id === route.version ||
          (n.document.source_id === route.source && n.document.external_id === route.item))
      ) || (n.children ?? []).some(contains);
    return (
      <Branch
        key={`${node.source_id}:${node.path.join("/")}:${node.kind}`}
        to={to}
        label={nameOf(node, say)}
        active={active}
        contains={contains(node) || active}
      >
        {node.children?.length ? node.children.map((n) => documents(n, space)) : undefined}
      </Branch>
    );
  };
  const topics = (all: TaxonomyNode[], parent?: string): ReactNode =>
    all
      .filter((t) => t.parent_key === parent)
      .map((t) => {
        const contains = (key: string): boolean =>
          route.name === "topic" &&
          (route.key === key || all.filter((n) => n.parent_key === key).some((n) => contains(n.key)));
        return (
          <Branch
            key={t.key}
            to={{ name: "topic", key: t.key }}
            label={t.title}
            active={route.name === "topic" && route.key === t.key}
            contains={contains(t.key)}
          >
            {all.some((n) => n.parent_key === t.key) ? topics(all, t.key) : undefined}
          </Branch>
        );
      });
  return (
    <nav className="left navigation" aria-label={say("nav.label")}>
      <Link to={{ name: "home" }} className="nav-item" current={route.name === "home"}>
        {say("nav.home")}
      </Link>
      <Link to={{ name: "inbox" }} className="nav-item" current={route.name === "inbox" || route.name === "todo"}>
        {say("nav.inbox")}
        <span className="count">{props.todos}</span>
      </Link>
      {library.spaces.map((s) => (
        <section key={s.id} className="nav-space">
          <div className="nav-space-name">{s.name}</div>
          <ul className="tree">
            <Branch
              to={{ name: "documents", space: s.id, folders: [] }}
              label={say("nav.documents")}
              active={route.name === "documents" && route.space === s.id && !route.source}
              contains={
                (route.name === "documents" && route.space === s.id) ||
                (route.name === "document" &&
                  (library.trees.get(s.id)?.sources.some((n) => n.source_id === route.source) ?? false))
              }
            >
              {library.trees.get(s.id)?.sources.map((n) => documents(n, s.id))}
            </Branch>
            <Branch
              to={{ name: "topics", space: s.id }}
              label={say("nav.knowledge")}
              active={route.name === "topics" && route.space === s.id}
              contains={
                route.name === "topic" && (library.topics.get(s.id)?.topics.some((t) => t.key === route.key) ?? false)
              }
            >
              {topics(library.topics.get(s.id)?.topics ?? [])}
            </Branch>
          </ul>
          <Link
            to={{ name: "imports", space: s.id }}
            className="nav-item nav-sub"
            current={route.name === "imports" && route.space === s.id}
          >
            {say("import.title")}
          </Link>
          {(s.role === "owner" || s.owner_id === props.person.member) && (
            <Link to={{ name: "maintain", space: s.id, page: "overview" }} className="nav-item nav-sub">
              {say("nav.maintain")}
            </Link>
          )}
        </section>
      ))}
    </nav>
  );
}
