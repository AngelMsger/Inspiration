// A space's knowledge: its outline of topics, and each topic as a page. The page says what
// holds for each fact, with the passage it rests on, and which documents still say otherwise;
// a value still being decided is marked so until its topic owner decides.

import type { Citation, Inbox, SearchHit, TaxonomyNode, TopicView } from "@inspiration/contracts";
import type { ReactNode } from "react";
import { api, type Library, type Loaded, useLoad } from "./api.ts";
import type { Person } from "./backend.ts";
import { citedAt } from "./home.tsx";
import { Crumbs, Failure, Standing } from "./parts.tsx";
import { Link } from "./route.tsx";
import { factOf, factTitle } from "./todos.ts";
import { pageOf } from "./topics.ts";
import { type Say, useWords } from "./words.ts";

const nameOf = (people: Person[], member: string | undefined) => people.find((p) => p.member === member)?.name;

function ownerLine(say: Say, people: Person[], node: TaxonomyNode): string {
  const name = nameOf(people, node.owner_id);
  return name ? say("topic.owner", { name }) : say("topic.no_owner");
}

export function TopicsScreen(props: { space: string; library: Library; people: Person[] }) {
  const { say } = useWords();
  const space = props.library.spaces.find((s) => s.id === props.space);
  const topics = props.library.topics.get(props.space)?.topics ?? [];
  const under = (parent: string | undefined) =>
    topics.filter((t) => t.parent_key === parent).sort((a, b) => a.ordinal - b.ordinal || a.key.localeCompare(b.key));
  const row = (t: TaxonomyNode): ReactNode => (
    <li key={t.key}>
      <div className="topic-row">
        <Link to={{ name: "topic", key: t.key }}>{t.title}</Link>
        <span className="quiet">{ownerLine(say, props.people, t)}</span>
      </div>
      {t.summary && <p className="quiet topic-summary">{t.summary}</p>}
      {under(t.key).length > 0 && <ul className="outline">{under(t.key).map(row)}</ul>}
    </li>
  );
  return (
    <main className="centre">
      <Crumbs>{[space?.name, say("knowledge.title")]}</Crumbs>
      <div className="heading">
        <h1 className="title">{say("knowledge.title")}</h1>
        <span className="quiet">{say("nav.topics", { count: topics.length })}</span>
      </div>
      {topics.length === 0 ? (
        <p className="quiet">{say("knowledge.empty")}</p>
      ) : (
        <ul className="outline outline-top">{under(undefined).map(row)}</ul>
      )}
    </main>
  );
}

export function TopicScreen(props: { topicKey: string; library: Library; people: Person[]; inbox: Loaded<Inbox> }) {
  const { say } = useWords();
  const view = useLoad(`topic:${props.topicKey}`, () => api.topic(props.topicKey));
  if (view.state !== "done") {
    return (
      <main className="centre">
        {view.state === "failed" ? (
          <Failure error={view.error} notFound={say("knowledge.not_found")} />
        ) : (
          <p className="quiet">{say("knowledge.loading")}</p>
        )}
      </main>
    );
  }
  return <Topic view={view.value} library={props.library} people={props.people} inbox={props.inbox} />;
}

/** Numbers the page's sources in reading order, as the answer numbers its citations. */
function numbering() {
  const seen = new Map<string, number>();
  return (c: Citation) => {
    const n = seen.get(c.span_id) ?? seen.size + 1;
    seen.set(c.span_id, n);
    return n;
  };
}

function Topic(props: { view: TopicView; library: Library; people: Person[]; inbox: Loaded<Inbox> }) {
  const { say } = useWords();
  const { view, people } = props;
  const { topic } = view;
  const page = pageOf(view);
  const number = numbering();
  const space = props.library.spaces.find((s) => s.id === topic.space_id);
  const keys = new Set([topic.key, ...view.subtopics.map((t) => t.key)]);
  const slots = new Set(page.facts.map((f) => f.slot_key));
  const pending =
    props.inbox.state === "done"
      ? props.inbox.value.cards.flatMap((card) =>
          card.todos
            .filter((t) => (card.topic && keys.has(card.topic.key)) || (t.todo.slot_key && slots.has(t.todo.slot_key)))
            .map((item) => ({ item, card })),
        )
      : [];
  const sources = (h: SearchHit) =>
    h.citations.map((c) => {
      const n = number(c);
      return (
        <sup key={`${c.span_id}-${n}`}>
          <Link to={citedAt(c)}>{n}</Link>
        </sup>
      );
    });
  const anchor = (i: number) => `fact-${i + 1}`;
  return (
    <div className="with-panel">
      <div className="reading">
        <div className="reading-head">
          <Crumbs>
            {[
              space && (
                <Link key="space" to={{ name: "topics", space: space.id }}>
                  {space.name}
                </Link>
              ),
              view.parent && (
                <Link key="parent" to={{ name: "topic", key: view.parent.key }}>
                  {view.parent.title}
                </Link>
              ),
              topic.title,
            ]}
          </Crumbs>
        </div>
        <article className="paper">
          <h1>{topic.title}</h1>
          <div className="meta">
            <span>{ownerLine(say, people, topic)}</span>
          </div>
          {view.subtopics.length > 0 && (
            <>
              <h2>{say("topic.subtopics")}</h2>
              <ul className="subtopics">
                {view.subtopics.map((t) => (
                  <li key={t.key}>
                    <Link to={{ name: "topic", key: t.key }}>{t.title}</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          {page.facts.map((fact, i) => (
            <section key={fact.slot_key} id={anchor(i)} className="fact">
              <h2>{factTitle(say, fact.label ?? topic.title, fact.slot_key)}</h2>
              {fact.current.map((h) => (
                <p key={h.unit_id}>
                  {h.snippet}
                  {sources(h)}
                  {fact.disputed && <Standing value="disputed" />}
                </p>
              ))}
              {fact.against.map((h) => (
                <p key={h.unit_id} className="against">
                  <Standing value={h.standing} />
                  <span>{say("topic.written", { title: h.title })}</span>
                  {h.snippet}
                  {sources(h)}
                </p>
              ))}
            </section>
          ))}
          {page.others.length > 0 && (
            <section className="fact">
              <h2>{say("topic.others")}</h2>
              {page.others.map((h) => (
                <p key={h.unit_id}>
                  {h.snippet}
                  {sources(h)}
                </p>
              ))}
            </section>
          )}
          {page.facts.length === 0 && page.others.length === 0 && <p className="quiet">{say("topic.none")}</p>}
        </article>
      </div>
      <aside className="panel" aria-label={say("topic.about")}>
        <div className="panel-title">{say("topic.about")}</div>
        {page.facts.length > 0 && (
          <>
            <h3>{say("topic.on_page")}</h3>
            <ul className="toc">
              {page.facts.map((fact, i) => (
                <li key={fact.slot_key}>
                  <a href={`#${anchor(i)}`}>{factTitle(say, fact.label ?? topic.title, fact.slot_key)}</a>
                  {fact.disputed && <Standing value="disputed" />}
                </li>
              ))}
            </ul>
          </>
        )}
        {pending.length > 0 && (
          <>
            <h3>{say("topic.pending")}</h3>
            {pending.map(({ item, card }) => (
              <p key={item.todo.id} className="excerpt">
                <Link to={{ name: "todo", id: item.todo.id }}>{factOf(say, item, card)}</Link>
                <span className="quiet"> · {say(`todo.${item.todo.kind}`)}</span>
              </p>
            ))}
          </>
        )}
        <h3>{say("topic.sources")}</h3>
        <p className="excerpt">{say("topic.places", { places: page.places, documents: page.documents })}</p>
      </aside>
    </div>
  );
}
