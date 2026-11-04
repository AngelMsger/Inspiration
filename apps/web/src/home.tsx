// Home and asking. Home has three things: ask, what you read lately, and your spaces. Asking
// answers first, every sentence with its source, then lists what search found.

import type { Citation, GroundedAnswer, SearchHit } from "@inspiration/contracts";
import { useState } from "react";
import { api, type Library, useLoad } from "./api.ts";
import type { Person } from "./backend.ts";
import { Failure, Standing } from "./parts.tsx";
import { Link, navigate, type Route } from "./route.tsx";
import { noteText } from "./todos.ts";
import { useWords } from "./words.ts";

interface Recent {
  title: string;
  where: string;
  source: string;
  item: string;
}

const recentKey = (member: string) => `inspiration.recent.${member}`;

/** The documents a person opened lately, newest first, as this browser remembers them. */
export function recentOf(member: string): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(recentKey(member)) ?? "[]") as Recent[];
  } catch {
    return [];
  }
}

export function remember(member: string, opened: Recent): void {
  const rest = recentOf(member).filter((r) => r.source !== opened.source || r.item !== opened.item);
  try {
    localStorage.setItem(recentKey(member), JSON.stringify([opened, ...rest].slice(0, 6)));
  } catch {
    // A browser that keeps nothing still shows the page; it just forgets.
  }
}

/** The link to the passage a citation names, in the Annotated view. */
export function citedAt(c: Citation, from?: string): Route {
  return { name: "document", version: c.source_version_id, span: c.span_id, view: "annotated", from };
}

export function AskBox(props: { initial: string }) {
  const { say } = useWords();
  const [text, setText] = useState(props.initial);
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) navigate({ name: "ask", q: text.trim() });
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={say("home.ask")}
        aria-label={say("home.ask")}
      />
      <kbd>⏎</kbd>
    </form>
  );
}

export function Home(props: { person: Person; library: Library }) {
  const { say } = useWords();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "home.morning" : hour < 18 ? "home.afternoon" : "home.evening";
  const recent = recentOf(props.person.member);
  return (
    <main className="centre">
      <h1 className="title">{say(greeting, { name: props.person.name })}</h1>
      <AskBox initial="" />
      <h2 className="section">{say("home.recent")}</h2>
      {recent.length === 0 ? (
        <p className="quiet">{say("home.recent_none")}</p>
      ) : (
        <ul className="rows">
          {recent.map((r) => (
            <li key={`${r.source}|${r.item}`}>
              <Link to={{ name: "document", source: r.source, item: r.item, view: "original" }}>{r.title}</Link>
              <span className="quiet">{r.where}</span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="section">{say("home.spaces")}</h2>
      <ul className="rows">
        {props.library.spaces.map((s) => (
          <li key={s.id}>
            <Link to={{ name: "documents", space: s.id, folders: [] }}>{s.name}</Link>
            <span className="quiet">{say("home.documents", { count: countOf(props.library, s.id) })}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

export const countOf = (library: Library, space: string) =>
  (library.trees.get(space)?.sources ?? []).reduce((n, s) => n + (s.document_count ?? 0), 0);

export function Ask(props: { q: string }) {
  const { say } = useWords();
  const answer = useLoad(`answer:${props.q}`, () => api.answer(props.q));
  const found = useLoad(`search:${props.q}`, () => api.search(props.q));
  return (
    <main className="centre">
      <AskBox key={props.q} initial={props.q} />
      <section className="answer" aria-label={say("ask.answer")}>
        {answer.state === "loading" && <p className="quiet">{say("ask.reading")}</p>}
        {answer.state === "failed" && <Failure error={answer.error} />}
        {answer.state === "done" && <Answer answer={answer.value} q={props.q} />}
      </section>
      {found.state === "done" && found.value.hits.length > 0 && (
        <>
          <h2 className="section">{say("ask.results", { count: found.value.hits.length })}</h2>
          <ul className="results">
            {found.value.hits.map((hit) => (
              <Hit key={hit.unit_id} hit={hit} q={props.q} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function Answer(props: { answer: GroundedAnswer; q: string }) {
  const { say } = useWords();
  const { answer, q } = props;
  if (!answer.answer.trim()) return <p className="quiet">{say("ask.none")}</p>;
  // The answer marks each sentence's source as [n], counting citations from 1.
  const parts = answer.answer.split(/\s*\[(\d+)\]/);
  return (
    <>
      <p className="answer-text">
        {parts.map((part, i) => {
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one answer, in order
          if (i % 2 === 0) return <span key={i}>{part}</span>;
          const c = answer.citations[Number(part) - 1];
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          return <sup key={i}>{c ? <Link to={citedAt(c, q)}>{part}</Link> : part}</sup>;
        })}
      </p>
      {(answer.notes ?? []).map((note) => (
        <p key={`${note.kind}-${note.text}`} className={`note note-${note.kind}`}>
          <b>{say(`note.${note.kind}`)}</b> {noteText(say, note)}
        </p>
      ))}
      {answer.gaps.length > 0 && (
        <p className="quiet">
          {say("ask.gaps")}: {answer.gaps.join(" · ")}
        </p>
      )}
      <ol className="sources" aria-label={say("ask.sources")}>
        {answer.citations.map((c) => (
          <li key={`${c.span_id}-${c.quote}`}>
            <Link to={citedAt(c, q)}>{c.source_title}</Link>
            <span className="quiet"> · {c.quote.length > 48 ? `${c.quote.slice(0, 48)}…` : c.quote}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Hit(props: { hit: SearchHit; q: string }) {
  const { say } = useWords();
  const { hit } = props;
  const first = hit.citations[0];
  return (
    <li>
      <div className="result-head">
        {first ? (
          <Link className="result-title" to={citedAt(first, props.q)}>
            {hit.title}
          </Link>
        ) : (
          <span className="result-title">{hit.title}</span>
        )}
        <span className="quiet">{say(`hit.${hit.kind}`)}</span>
        <span className="grow" />
        <Standing value={hit.standing} quiet />
      </div>
      <span className="quiet snippet">{hit.snippet}</span>
    </li>
  );
}
