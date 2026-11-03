// The frame every screen shares: the top bar (the company, search and ask, the account), the
// left column of the Knowledge area, then the screen the address names. Reading a document
// folds the left column away.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiFailure, api, failureOf, type Library, loadLibrary, useLoad } from "./api.ts";
import type { Person, Session } from "./backend.ts";
import { DocumentScreen } from "./document.tsx";
import { Documents } from "./documents.tsx";
import { Ask, countOf, Home } from "./home.tsx";
import { Palette } from "./palette.tsx";
import { Failure } from "./parts.tsx";
import { Link, type Route, useRoute } from "./route.tsx";
import { chooseTag, TAGS, type Tag, useWords, Words, wordsOf } from "./words.ts";

const LANGUAGE = "inspiration.language";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<Session>();
  const [failure, setFailure] = useState<ApiFailure>();
  const [picked, setPicked] = useState(() => stored(LANGUAGE));
  const tag = chooseTag(picked, session?.person.locale);
  const words = useMemo(() => ({ say: wordsOf(tag), tag }), [tag]);

  useEffect(() => {
    api.session().then(setSession, (e: unknown) => setFailure(failureOf(e)));
  }, []);
  useEffect(() => {
    document.documentElement.lang = tag === "zh" ? "zh-CN" : tag;
  }, [tag]);

  const actAs = useCallback(
    (member: string) => api.actAs(member).then(setSession, (e: unknown) => setFailure(failureOf(e))),
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
      {session && <Shell key={session.person.member} session={session} onActAs={actAs} onLanguage={speak} />}
    </Words.Provider>
  );
}

function Shell(props: {
  session: Session;
  onActAs: (member: string) => Promise<void>;
  onLanguage: (tag: Tag) => void;
}) {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  const library = useLoad("library", loadLibrary);
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
        onSearch={() => setPalette(true)}
        onActAs={props.onActAs}
        onLanguage={props.onLanguage}
      />
      <div className="body">
        {library.state === "failed" && <Failure error={library.error} />}
        {library.state === "done" && (
          <>
            {route.name !== "document" && <LeftColumn route={route} library={library.value} />}
            <Screen route={route} library={library.value} person={props.session.person} />
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

function Screen(props: { route: Route; library: Library; person: Person }) {
  const { route, library, person } = props;
  switch (route.name) {
    case "home":
      return <Home person={person} library={library} />;
    case "ask":
      return <Ask key={route.q} q={route.q} />;
    case "documents":
      return <Documents route={route} library={library} />;
    case "document":
      return <DocumentScreen route={route} library={library} person={person} />;
  }
}

function TopBar(props: {
  company: string;
  session: Session;
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

function LeftColumn(props: { route: Route; library: Library }) {
  const { say } = useWords();
  const { route, library } = props;
  return (
    <nav className="left" aria-label={say("nav.label")}>
      <Link to={{ name: "home" }} className="nav-item" current={route.name === "home"}>
        {say("nav.home")}
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
        </div>
      ))}
    </nav>
  );
}
