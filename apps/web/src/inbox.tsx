// The inbox: what is waiting for the person, card by card, and the decision a conflict asks
// for. Confirming the suggestion is one press on the card; the decision page shows both sides
// before the person chooses. A confirmed choice changes what readers and agents see at once.

import type { Inbox, InboxCard, InboxTodo, Todo } from "@inspiration/contracts";
import { type ReactNode, useRef, useState } from "react";
import { api, failureOf, type Loaded } from "./api.ts";
import type { Person } from "./backend.ts";
import { citedAt } from "./home.tsx";
import { Crumbs, Failure, Standing } from "./parts.tsx";
import { Link, type Route } from "./route.tsx";
import { factOf, type Side, sidesOf, valueText, weekOf } from "./todos.ts";
import { type Say, useWords } from "./words.ts";

/** What a resolved todo changed, for the confirmation shown in its place. */
interface Outcome {
  todo: string;
  text: string;
  /** Where the values chosen against are now marked outdated. */
  marks: { title: string; to: Route }[];
  /** The topic whose page now shows the chosen value. */
  topic?: { key: string; title: string };
}

/** The latest inbox loaded, kept on screen while the next one loads. */
function useLatest(loaded: Loaded<Inbox>): Inbox | undefined {
  const last = useRef<Inbox>(undefined);
  if (loaded.state === "done") last.current = loaded.value;
  return last.current;
}

/** The open todos a person has. */
export function countTodos(inbox: Inbox | undefined): number {
  return (inbox?.cards ?? []).reduce((n, c) => n + c.todos.length, 0);
}

export function InboxScreen(props: { person: Person; inbox: Loaded<Inbox>; onChanged: () => void }) {
  const { say } = useWords();
  const inbox = useLatest(props.inbox);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const resolved = (o: Outcome) => {
    setOutcomes((all) => [o, ...all]);
    props.onChanged();
  };
  const done = new Set(outcomes.map((o) => o.todo));
  const cards = (inbox?.cards ?? [])
    .map((c) => ({ ...c, todos: c.todos.filter((t) => !done.has(t.todo.id)) }))
    .filter((c) => c.todos.length);
  const week = weekOf(inbox?.cards[0]?.week);
  return (
    <main className="centre">
      <div className="heading">
        <h1 className="title">{say("inbox.title")}</h1>
        <span className="quiet">
          {[week && say("inbox.week", { week }), props.person.name].filter(Boolean).join(" · ")}
        </span>
      </div>
      {outcomes.map((o) => (
        <OutcomeView key={o.todo} outcome={o} />
      ))}
      {props.inbox.state === "failed" && <Failure error={props.inbox.error} />}
      {!inbox && props.inbox.state === "loading" && <p className="quiet">{say("inbox.loading")}</p>}
      {inbox && cards.length === 0 && <p className="quiet">{say("inbox.empty")}</p>}
      {cards.flatMap((card) =>
        card.todos.map((t) => <TodoCard key={t.todo.id} item={t} card={card} onResolved={resolved} />),
      )}
    </main>
  );
}

function OutcomeView(props: { outcome: Outcome }) {
  const { say } = useWords();
  return (
    <div className="outcome" role="status">
      <p>{props.outcome.text}</p>
      {props.outcome.marks.map((m) => (
        <Link key={m.title} to={m.to}>
          {say("inbox.see_marks", { title: m.title })}
        </Link>
      ))}
      {props.outcome.topic && (
        <Link to={{ name: "topic", key: props.outcome.topic.key }}>
          {say("inbox.see_topic", { title: props.outcome.topic.title })}
        </Link>
      )}
    </div>
  );
}

/** What resolving a todo with a side changed, in the reader's words. */
function outcomeOf(say: Say, todo: Todo, chosen: Side | undefined, sides: Side[], card: InboxCard): Outcome {
  const marks = sides.flatMap((s) => {
    const cited = s !== chosen && s.statement?.citations[0];
    return cited ? [{ title: s.statement?.title as string, to: citedAt(cited) }] : [];
  });
  return {
    todo: todo.id,
    text: chosen ? say("inbox.decided", { value: valueText(say, chosen.choice.value) }) : say("inbox.noted"),
    marks: chosen ? marks : [],
    ...(chosen && card.topic && { topic: { key: card.topic.key, title: card.topic.title } }),
  };
}

function TodoCard(props: { item: InboxTodo; card: InboxCard; onResolved: (o: Outcome) => void }) {
  const { say } = useWords();
  const { item, card } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf>>();
  const sides = sidesOf(item);
  const suggested = sides[0];
  const titleOf = (s: Side) => s.statement?.title ?? say("inbox.hidden");
  const resolve = (side: Side | undefined) => {
    setBusy(true);
    api.resolve(item.todo.id, side ? { with: side.choice.key } : { status: "done" }).then(
      (todo) => props.onResolved(outcomeOf(say, todo, side, sides, card)),
      (e: unknown) => {
        setBusy(false);
        setFailure(failureOf(e));
      },
    );
  };
  return (
    <article className="todo-card">
      <div className="todo-meta">
        <span className={`kind kind-${item.todo.kind}`}>{say(`todo.${item.todo.kind}`)}</span>
        {card.week && <span className="quiet">{say("inbox.week", { week: weekOf(card.week) })}</span>}
      </div>
      <h2>{factOf(say, item, card)}</h2>
      {sides.length > 0 ? (
        <p className="quiet todo-sides">
          {sides
            .map((s) => say("inbox.side", { value: valueText(say, s.choice.value), title: titleOf(s) }))
            .join(" · ")}
        </p>
      ) : (
        <ul className="todo-statements">
          {item.statements.map((h) => (
            <li key={h.unit_id}>
              <Standing value={h.standing} />
              <span>{h.snippet}</span>
              <span className="quiet"> {say("quote.title", { title: h.title })}</span>
            </li>
          ))}
        </ul>
      )}
      {suggested && (
        <p className="suggest">
          {say("inbox.suggested", { value: valueText(say, suggested.choice.value), title: titleOf(suggested) })}
        </p>
      )}
      {failure && <Failure error={failure} />}
      <div className="actions">
        {suggested ? (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => resolve(suggested)}>
              {say("inbox.confirm", { value: valueText(say, suggested.choice.value) })}
            </button>
            <Link to={{ name: "todo", id: item.todo.id }}>{say("inbox.open")}</Link>
          </>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={() => resolve(undefined)}>
            {say("inbox.acknowledge")}
          </button>
        )}
      </div>
    </article>
  );
}

/** One conflict, both sides first, then the person's choice. */
export function DecisionScreen(props: { id: string; inbox: Loaded<Inbox>; onChanged: () => void }) {
  const { say } = useWords();
  const inbox = useLatest(props.inbox);
  const [outcome, setOutcome] = useState<Outcome>();
  const found = (inbox?.cards ?? []).flatMap((card) =>
    card.todos.filter((t) => t.todo.id === props.id).map((item) => ({ item, card })),
  )[0];
  const back = <Link to={{ name: "inbox" }}>{say("inbox.title")}</Link>;
  if (outcome) {
    return (
      <main className="centre">
        <Crumbs>{[back, say("decision.yours")]}</Crumbs>
        <OutcomeView outcome={outcome} />
        <Link to={{ name: "inbox" }}>{say("decision.back")}</Link>
      </main>
    );
  }
  if (!found) {
    return (
      <main className="centre">
        <Crumbs>{[back]}</Crumbs>
        {props.inbox.state === "failed" && <Failure error={props.inbox.error} />}
        <p className="quiet">{inbox ? say("decision.not_found") : say("inbox.loading")}</p>
      </main>
    );
  }
  return (
    <Decision
      item={found.item}
      card={found.card}
      back={back}
      onResolved={(o) => {
        setOutcome(o);
        props.onChanged();
      }}
    />
  );
}

function Decision(props: { item: InboxTodo; card: InboxCard; back: ReactNode; onResolved: (o: Outcome) => void }) {
  const { say } = useWords();
  const { item, card } = props;
  const sides = sidesOf(item);
  const [picked, setPicked] = useState(sides[0]?.choice.key);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf>>();
  const fact = factOf(say, item, card);
  const held = sides[0];
  const value = (s: Side | undefined) => valueText(say, s?.choice.value);
  const titleOf = (s: Side) => s.statement?.title ?? say("inbox.hidden");
  const disputed = sides.some((s) => s.statement?.standing === "disputed");
  const now = disputed
    ? say("decision.now_disputed", { value: value(held) })
    : say("decision.now_outdated", { value: value(held), others: sides.slice(1).map(value).join(say("list.mark")) });
  const resolve = (how: { with?: string; status?: "dismissed" }) => {
    setBusy(true);
    api.resolve(item.todo.id, how).then(
      (todo) => {
        const chosen = sides.find((s) => s.choice.key === how.with);
        props.onResolved(
          chosen ? outcomeOf(say, todo, chosen, sides, card) : { todo: todo.id, text: say("inbox.noted"), marks: [] },
        );
      },
      (e: unknown) => {
        setBusy(false);
        setFailure(failureOf(e));
      },
    );
  };
  return (
    <div className="with-panel">
      <main className="centre">
        <Crumbs>{[props.back, fact]}</Crumbs>
        <div className="heading">
          <h1 className="title">{fact}</h1>
          <span className={`kind kind-${item.todo.kind}`}>{say(`todo.${item.todo.kind}`)}</span>
        </div>
        <p>{now}</p>
        <div className="sides">
          {sides.map((s) => (
            <section key={s.choice.key} className="side">
              <div className="side-value">{value(s)}</div>
              {s.statement?.citations[0] ? (
                <Link to={citedAt(s.statement.citations[0])}>{say("quote.title", { title: titleOf(s) })}</Link>
              ) : (
                <span>{say("quote.title", { title: titleOf(s) })}</span>
              )}
              <Standing value={s.statement?.standing} />
              {s.statement && <blockquote>{s.statement.snippet}</blockquote>}
            </section>
          ))}
        </div>
        <fieldset className="choices" disabled={busy}>
          <legend>{say("decision.yours")}</legend>
          {sides.map((s) => (
            <label key={s.choice.key} className={picked === s.choice.key ? "choice choice-picked" : "choice"}>
              <input
                type="radio"
                name="choice"
                value={s.choice.key}
                checked={picked === s.choice.key}
                onChange={() => setPicked(s.choice.key)}
              />
              <span>{say("decision.choice", { value: value(s), title: titleOf(s) })}</span>
              {s.suggested && <span className="tag">{say("decision.suggested")}</span>}
            </label>
          ))}
        </fieldset>
        {failure && <Failure error={failure} />}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !picked}
            onClick={() => resolve({ ...(picked && { with: picked }) })}
          >
            {busy ? say("decision.confirming") : say("decision.confirm")}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => resolve({ status: "dismissed" })}>
            {say("decision.dismiss")}
          </button>
        </div>
      </main>
      <aside className="panel" aria-label={say("decision.about")}>
        <div className="panel-title">{say("decision.about")}</div>
        {card.topic && (
          <>
            <h3>{say("decision.topic")}</h3>
            <p className="excerpt">
              <Link to={{ name: "topic", key: card.topic.key }}>{card.topic.title}</Link>
            </p>
          </>
        )}
        <h3>{say("decision.after")}</h3>
        <p className="excerpt">
          {say("decision.after_text", { value: value(sides.find((s) => s.choice.key === picked)) })}
        </p>
      </aside>
    </div>
  );
}
