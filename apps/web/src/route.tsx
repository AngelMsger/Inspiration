// Every state of the page has its own address, so the browser's Back always works and any
// screen can be linked to. A route is parsed from the address and written back to it. A
// snapshot (snapshot.ts) is served as one static page, so there the address is the part after
// "#" (<html data-routes="hash">, which recorded.tsx sets).

import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

export type DocumentRoute = {
  name: "document";
  /** The latest version of a source item, or the version a citation names. */
  source?: string;
  item?: string;
  version?: string;
  view: "original" | "annotated";
  /** The passage to select: a block, or the block holding a cited span. */
  block?: string;
  span?: string;
  /** The question the reader came from, for the way back. */
  from?: string;
};

export type Route =
  | { name: "home" }
  | { name: "ask"; q: string }
  | { name: "inbox" }
  | { name: "todo"; id: string }
  | { name: "topics"; space: string }
  | { name: "topic"; key: string }
  | { name: "documents"; space: string; source?: string; folders: string[] }
  | { name: "maintain"; space: string; page: "overview" | "topics" | "documents" }
  | { name: "admin"; page: "members" | "invites" }
  | { name: "join"; code: string }
  | DocumentRoute;

export function parse(url: URL): Route {
  const q = url.searchParams;
  const get = (key: string) => q.get(key) ?? undefined;
  const space = url.pathname.match(/^\/spaces\/([^/]+)\/documents$/);
  if (space?.[1]) {
    return {
      name: "documents",
      space: decodeURIComponent(space[1]),
      source: get("source"),
      folders: q.getAll("folder"),
    };
  }
  const maintain = url.pathname.match(/^\/spaces\/([^/]+)\/maintain(?:\/(topics|documents))?$/);
  if (maintain?.[1]) {
    const page = maintain[2] === "topics" || maintain[2] === "documents" ? maintain[2] : "overview";
    return { name: "maintain", space: decodeURIComponent(maintain[1]), page };
  }
  const knowledge = url.pathname.match(/^\/spaces\/([^/]+)\/knowledge$/);
  if (knowledge?.[1]) return { name: "topics", space: decodeURIComponent(knowledge[1]) };
  const topic = url.pathname.match(/^\/topics\/([^/]+)$/);
  if (topic?.[1]) return { name: "topic", key: decodeURIComponent(topic[1]) };
  const admin = url.pathname.match(/^\/admin(?:\/(members|invites))?$/);
  if (admin) return { name: "admin", page: admin[1] === "invites" ? "invites" : "members" };
  const join = url.pathname.match(/^\/join\/([^/]+)$/);
  if (join?.[1]) return { name: "join", code: decodeURIComponent(join[1]) };
  if (url.pathname === "/ask") return { name: "ask", q: get("q") ?? "" };
  if (url.pathname === "/inbox") return { name: "inbox" };
  const todo = url.pathname.match(/^\/inbox\/([^/]+)$/);
  if (todo?.[1]) return { name: "todo", id: decodeURIComponent(todo[1]) };
  if (url.pathname === "/document") {
    return {
      name: "document",
      source: get("source"),
      item: get("item"),
      version: get("version"),
      view: get("view") === "annotated" ? "annotated" : "original",
      block: get("block"),
      span: get("span"),
      from: get("from"),
    };
  }
  return { name: "home" };
}

export function href(route: Route): string {
  const query = (pairs: [string, string | undefined][]) => {
    const q = new URLSearchParams();
    for (const [k, v] of pairs) if (v) q.append(k, v);
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  switch (route.name) {
    case "home":
      return "/";
    case "ask":
      return `/ask${query([["q", route.q]])}`;
    case "inbox":
      return "/inbox";
    case "todo":
      return `/inbox/${encodeURIComponent(route.id)}`;
    case "topics":
      return `/spaces/${encodeURIComponent(route.space)}/knowledge`;
    case "topic":
      return `/topics/${encodeURIComponent(route.key)}`;
    case "maintain":
      return `/spaces/${encodeURIComponent(route.space)}/maintain${route.page === "overview" ? "" : `/${route.page}`}`;
    case "admin":
      return `/admin/${route.page}`;
    case "join":
      return `/join/${encodeURIComponent(route.code)}`;
    case "documents":
      return `/spaces/${encodeURIComponent(route.space)}/documents${query([
        ["source", route.source],
        ...route.folders.map((f): [string, string] => ["folder", f]),
      ])}`;
    case "document":
      return `/document${query([
        ["source", route.source],
        ["item", route.item],
        ["version", route.version],
        ["view", route.view === "annotated" ? "annotated" : undefined],
        ["block", route.block],
        ["span", route.span],
        ["from", route.from],
      ])}`;
  }
}

const CHANGED = "inspiration:navigate";

const inHash = () => document.documentElement.dataset.routes === "hash";

/** Where a route lives in this page's address bar. */
function addressOf(route: Route): string {
  return inHash() ? `#${href(route)}` : href(route);
}

/** The address the route is read from. */
function here(): URL {
  return inHash() ? new URL(location.hash.slice(1) || "/", location.origin) : new URL(location.href);
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const to = addressOf(route);
  // A snapshot changes only the part after "#", which any frame it is shown in allows.
  if (inHash()) location[options.replace ? "replace" : "assign"](to);
  else if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGED));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(here()));
  useEffect(() => {
    const update = () => setRoute(parse(here()));
    for (const event of ["popstate", "hashchange", CHANGED]) window.addEventListener(event, update);
    return () => {
      for (const event of ["popstate", "hashchange", CHANGED]) window.removeEventListener(event, update);
    };
  }, []);
  return route;
}

/** A link that moves within the page, and still opens in a new tab with a modifier key. */
export function Link(props: { to: Route; className?: string; children: ReactNode; current?: boolean }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.to);
  };
  return (
    <a
      href={addressOf(props.to)}
      className={props.className}
      onClick={onClick}
      aria-current={props.current ? "page" : undefined}
    >
      {props.children}
    </a>
  );
}
