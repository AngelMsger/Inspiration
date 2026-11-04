// The frame every screen shares: the top bar (the company, search and ask, the account), the
// left column of the Knowledge area, then the screen the address names. Reading a document
// folds the left column away.

import type { Inbox } from "@inspiration/contracts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiFailure, api, failureOf, type Library, type Loaded, loadLibrary, useLoad } from "./api.ts";
import type { Person, Session } from "./backend.ts";
import { DocumentScreen } from "./document.tsx";
import { Documents } from "./documents.tsx";
import { Ask, countOf, Home } from "./home.tsx";
import { countTodos, DecisionScreen, InboxScreen } from "./inbox.tsx";
import { TopicScreen, TopicsScreen } from "./knowledge.tsx";
import { Palette } from "./palette.tsx";
import { Failure } from "./parts.tsx";
import { Link, type Route, useRoute } from "./route.tsx";
import { MaintainColumn, MaintainScreen } from "./space.tsx";
import { chooseTag, TAGS, type Tag, useWords, Words, wordsOf } from "./words.ts";

const LANGUAGE = "inspiration.language";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A person's library, read before their shell is shown. */
interface Entry {
  member: string;
  library: Library;
}

/** Whom the app acts as, with their library when it could be read; the shell reads it again otherwise. */
async function enter(session: Session): Promise<{ session: Session; entry?: Entry }> {
  const library = await loadLibrary().catch(() => undefined);
  return { session, ...(library && { entry: { member: session.person.member, library } }) };
}

/**
 * The app. `generation` counts the times the data under it changed without its doing, as when
 * a snapshot's guide moves to another step: it reads whom it acts as again, and the screens
 * start over. Whoever it acts as next, it reads their library before it shows their shell, so
 * the old frame stays on screen meanwhile and no one's frame shows another person's spaces.
 */
export function App(props: { generation?: number }) {
  const generation = props.generation ?? 0;
  const [session, setSession] = useState<Session>();
  // The generation the session was read in; the shell starts over when it changes.
  const [readIn, setReadIn] = useState(generation);
  const [failure, setFailure] = useState<ApiFailure>();
  const [picked, setPicked] = useState(() => stored(LANGUAGE));
  const tag = chooseTag(picked, session?.person.locale);
  const words = useMemo(() => ({ say: wordsOf(tag), tag }), [tag]);
  // The library the next shell starts with, for the member it was read as.
  const entry = useRef<Entry>(undefined);

  useEffect(() => {
    let current = true;
    api
      .session()
      .then(enter)
      .then(
        (next) => {
          if (!current) return;
          entry.current = next.entry;
          setSession(next.session);
          setReadIn(generation);
        },
        (e: unknown) => current && setFailure(failureOf(e)),
      );
    return () => {
      current = false;
    };
  }, [generation]);
  useEffect(() => {
    document.documentElement.lang = tag === "zh" ? "zh-CN" : tag;
  }, [tag]);

  const actAs = useCallback(
    (member: string) =>
      api
        .actAs(member)
        .then(enter)
        .then(
          (next) => {
            entry.current = next.entry;
            setSession(next.session);
          },
          (e: unknown) => setFailure(failureOf(e)),
        ),
    [],
  );
  const speak = useCallback((t: Tag) => {
    setPicked(t);
    try {
      localStorage.setItem(LANGUAGE, t);
    } catch {
      // Kept for this visit only.
    }
  }, []);

  return (
    <Words.Provider value={words}>
      {failure && <Failure error={failure} />}
      {/* Acting as someone else starts over with what they may see. */}
      {session && (
        <Shell
          key={`${readIn}:${session.person.member}`}
          session={session}
          entry={entry}
          onActAs={actAs}
          onLanguage={speak}
        />
      )}
    </Words.Provider>
  );
}

function Shell(props: {
  session: Session;
  /** The library already read for this person, if any; the shell keeps its latest there. */
  entry: RefObject<Entry | undefined>;
  onActAs: (member: string) => Promise<void>;
  onLanguage: (tag: Tag) => void;
}) {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  // A synced source changes the documents; the library is read again, and shown as it was
  // meanwhile. Only this person's library is ever shown, and a failure to read it shows.
  const member = props.session.person.member;
  const seed = props.entry.current?.member === member ? props.entry.current.library : undefined;
  const [synced, setSynced] = useState(0);
  const loaded = useLoad(`library:${synced}`, () => (synced === 0 && seed ? Promise.resolve(seed) : loadLibrary()));
  const shown = useRef(seed);
  if (loaded.state === "done") {
    shown.current = loaded.value;
    props.entry.current = { member, library: loaded.value };
  }
  const library: Loaded<Library> =
    loaded.state !== "failed" && shown.current ? { state: "done", value: shown.current } : loaded;
  // Resolving a todo changes the inbox; its count in the left column follows.
  const [changes, setChanges] = useState(0);
  const inbox = useLoad(`inbox:${changes}:${synced}`, api.inbox);
  const changed = useCallback(() => setChanges((n) => n + 1), []);
  const sourcesChanged = useCallback(() => setSynced((n) => n + 1), []);
  const todos = useRef(0);
  if (inbox.state === "done") todos.current = countTodos(inbox.value);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TopBar
        company={library.state === "done" ? library.value.tenant.name : ""}
        session={props.session}
        todos={todos.current}
        onSearch={() => setPalette(true)}
        onActAs={props.onActAs}
        onLanguage={props.onLanguage}
      />
      <div className="body">
        {library.state === "failed" && <Failure error={library.error} />}
        {library.state === "done" && (
          <>
            {route.name === "maintain" ? (
              <MaintainColumn route={route} library={library.value} />
            ) : (
              route.name !== "document" && (
                <LeftColumn route={route} library={library.value} person={props.session.person} todos={todos.current} />
              )
            )}
            <Screen
              route={route}
              library={library.value}
              person={props.session.person}
              people={props.session.people}
              inbox={inbox}
              version={changes + synced}
              onChanged={changed}
              onSourcesChanged={sourcesChanged}
            />
          </>
        )}
      </div>
      {palette && library.state === "done" && (
        <Palette
          library={library.value}
          people={props.session.people}
          onActAs={(m) => void props.onActAs(m)}
          onLanguage={props.onLanguage}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}

function Screen(props: {
  route: Route;
  library: Library;
  person: Person;
  people: Person[];
  inbox: Loaded<Inbox>;
  version: number;
  onChanged: () => void;
  onSourcesChanged: () => void;
}) {
  const { route, library, person, people } = props;
  switch (route.name) {
    case "home":
      return <Home person={person} library={library} />;
    case "ask":
      return <Ask key={route.q} q={route.q} />;
    case "inbox":
      return <InboxScreen person={person} inbox={props.inbox} onChanged={props.onChanged} />;
    case "todo":
      return <DecisionScreen key={route.id} id={route.id} inbox={props.inbox} onChanged={props.onChanged} />;
    case "topics":
      return <TopicsScreen space={route.space} library={library} people={people} />;
    case "topic":
      return <TopicScreen key={route.key} topicKey={route.key} library={library} people={people} inbox={props.inbox} />;
    case "documents":
      return <Documents route={route} library={library} />;
    case "document":
      return <DocumentScreen route={route} library={library} person={person} />;
    case "maintain":
      return (
        <MaintainScreen
          route={route}
          library={library}
          people={people}
          version={props.version}
          onSourcesChanged={props.onSourcesChanged}
        />
      );
  }
}

function TopBar(props: {
  company: string;
  session: Session;
  /** Open todos, shown in the bar while the left column is hidden (phones). */
  todos: number;
  onSearch: () => void;
  onActAs: (member: string) => Promise<void>;
  onLanguage: (tag: Tag) => void;
}) {
  const { say, tag } = useWords();
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => menu.current?.removeAttribute("open");
  const person = props.session.person;
  return (
    <header className="top">
      <Link to={{ name: "home" }} className="wordmark">
        Inspiration
      </Link>
      {props.company && <span className="company">{props.company}</span>}
      <button type="button" className="search" onClick={props.onSearch}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <span className="grow">{say("top.search")}</span>
        <kbd>⌘K</kbd>
      </button>
      <span className="grow" />
      {props.todos > 0 && (
        <Link to={{ name: "inbox" }} className="top-inbox">
          {say("nav.inbox")}
          <span className="badge">{props.todos}</span>
        </Link>
      )}
      <details className="account" ref={menu}>
        <summary aria-label={say("top.account", { name: person.name })}>{person.name.slice(0, 1)}</summary>
        <div className="menu">
          <div className="menu-person">
            <b>{person.name}</b>
            {person.about && <span className="quiet">{person.about}</span>}
          </div>
          <div className="menu-heading">{say("account.acting_as")}</div>
          {props.session.people.map((p) => (
            <button
              key={p.member}
              type="button"
              aria-current={p.member === person.member}
              onClick={() => {
                close();
                void props.onActAs(p.member);
              }}
            >
              {p.name}
              {p.about && <span className="quiet">{p.about}</span>}
            </button>
          ))}
          <div className="menu-heading">{say("account.language")}</div>
          {TAGS.map((t) => (
            <button
              key={t}
              type="button"
              aria-current={t === tag}
              onClick={() => {
                close();
                props.onLanguage(t);
              }}
            >
              {wordsOf(t)("language.name")}
            </button>
          ))}
        </div>
      </details>
    </header>
  );
}

function LeftColumn(props: { route: Route; library: Library; person: Person; todos: number }) {
  const { say } = useWords();
  const { route, library } = props;
  const topicSpace =
    route.name === "topic"
      ? [...library.topics.values()].find((l) => l.topics.some((t) => t.key === route.key))?.space_id
      : undefined;
  return (
    <nav className="left" aria-label={say("nav.label")}>
      <Link to={{ name: "home" }} className="nav-item" current={route.name === "home"}>
        {say("nav.home")}
      </Link>
      <Link
        to={{ name: "inbox" }}
        className={props.todos > 0 ? "nav-item nav-todos" : "nav-item"}
        current={route.name === "inbox" || route.name === "todo"}
      >
        <span>{say("nav.inbox")}</span>
        {props.todos > 0 && (
          <span key={props.todos} className="badge">
            {props.todos}
          </span>
        )}
      </Link>
      <div className="nav-heading">{say("nav.spaces")}</div>
      {library.spaces.map((s) => (
        <div key={s.id} className="nav-space">
          <div className="nav-space-name">{s.name}</div>
          <Link
            to={{ name: "documents", space: s.id, folders: [] }}
            className="nav-item nav-sub"
            current={route.name === "documents" && route.space === s.id}
          >
            <span>{say("nav.documents")}</span>
            <span className="count">{countOf(library, s.id)}</span>
          </Link>
          <Link
            to={{ name: "topics", space: s.id }}
            className="nav-item nav-sub"
            current={(route.name === "topics" && route.space === s.id) || topicSpace === s.id}
          >
            <span>{say("nav.knowledge")}</span>
            <span className="count">{library.topics.get(s.id)?.topics.length ?? 0}</span>
          </Link>
          {s.owner_id === props.person.member && (
            <Link to={{ name: "maintain", space: s.id, page: "overview" }} className="nav-item nav-sub nav-maintain">
              {say("nav.maintain")}
            </Link>
          )}
        </div>
      ))}
    </nav>
  );
}
