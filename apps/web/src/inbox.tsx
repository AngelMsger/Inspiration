// The inbox: what is waiting for the person, card by card, and the decision a conflict asks
// for. Confirming the suggestion is one press on the card; the decision page shows both sides
// before the person chooses. A confirmed choice changes what readers and agents see at once.
//
// Decide for me (decide.tsx) shows once the engine answers the member's standing delegation:
// one press lets the assistant decide card by card, and what it left stays in place, marked
// with why and with its suggestion selected. The sample company only reads, so it has none.

import type {
  Decided,
  Delegation,
  Inbox,
  InboxCard,
  InboxTodo,
  LeftTodo,
  Todo,
  TodoDecision,
} from "@inspiration/contracts";
import { type ReactNode, useRef, useState } from "react";
import { api, failureOf, type Loaded, useLoad } from "./api.ts";
import { marked, suggestedSide } from "./decide.ts";
import { AlwaysDecide, DecideBar, DecidedFold } from "./decide.tsx";
import { citedAt } from "./home.tsx";
import { Crumbs, Failure, Standing } from "./parts.tsx";
import type { Person } from "./people.ts";
import { Link, type Route } from "./route.tsx";
import { choiceText, factOf, type Side, sidesOf, valueText, weekOf } from "./todos.ts";
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

/** The member's standing Decide for me, kept on screen while it is read again; none in the sample company. */
function useDelegation(sampled: boolean): { delegation?: Delegation; reread: () => void } {
  const [version, setVersion] = useState(0);
  const loaded = useLoad(`delegation:${sampled}:${version}`, () =>
    sampled ? Promise.resolve(undefined) : api.delegation(),
  );
  const last = useRef<Delegation>(undefined);
  if (loaded.state === "done") last.current = loaded.value;
  return { ...(last.current && { delegation: last.current }), reread: () => setVersion((v) => v + 1) };
}

export function InboxScreen(props: { person: Person; inbox: Loaded<Inbox>; sampled: boolean; onChanged: () => void }) {
  const { say } = useWords();
  const inbox = useLatest(props.inbox);
  const { delegation, reread } = useDelegation(props.sampled);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  // What the assistant decided and left in this visit, kept until the inbox read again holds it.
  const [decisions, setDecisions] = useState<{ decision: TodoDecision; fact: string }[]>([]);
  const [marks, setMarks] = useState<ReadonlyMap<string, LeftTodo>>(new Map());
  const resolved = (o: Outcome) => {
    setOutcomes((all) => [o, ...all]);
    props.onChanged();
  };
  const done = new Set([...outcomes.map((o) => o.todo), ...decisions.map((d) => d.decision.todo.id)]);
  const cards = (inbox?.cards ?? [])
    .map((c) => ({ ...c, todos: c.todos.filter((t) => !done.has(t.todo.id)).map((t) => marked(t, marks)) }))
    .filter((c) => c.todos.length);
  const facts = new Map(cards.flatMap((c) => c.todos.map((t) => [t.todo.id, factOf(say, t, c)] as const)));
  const onCard = (d: Decided) => {
    setDecisions((all) => [
      ...d.decisions.map((decision) => ({ decision, fact: facts.get(decision.todo.id) ?? decision.todo.title })),
      ...all,
    ]);
    setMarks((all) => new Map([...all, ...d.left.map((l) => [l.todo_id, l] as const)]));
  };
  const undone = (decision: TodoDecision) => {
    setDecisions((all) => all.filter((d) => d.decision.id !== decision.id));
    props.onChanged();
    // Undoing two of its last ten decisions of a kind pauses the standing delegation.
    reread();
  };
  const week = weekOf(inbox?.cards[0]?.week);
  const open = cards.reduce((n, c) => n + c.todos.length, 0);
  return (
    <main className="centre">
      <div className="heading">
        <h1 className="title">{say("inbox.title")}</h1>
        {open > 0 && (
          <span key={open} className="heading-count">
            {say("inbox.count", { count: open })}
          </span>
        )}
        <span className="quiet">
          {[week && say("inbox.week", { week }), props.person.name].filter(Boolean).join(" · ")}
        </span>
      </div>
      {delegation && !props.sampled && (
        <>
          <DecideBar cards={cards} onCard={onCard} onDone={props.onChanged} />
          <AlwaysDecide delegation={delegation} onChanged={reread} />
          {(decisions.length > 0 || marks.size > 0) && (
            <DecidedFold decisions={decisions} left={marks.size} onUndone={undone} />
          )}
        </>
      )}
      {outcomes.map((o) => (
        <OutcomeView key={o.todo} outcome={o} />
      ))}
      {props.inbox.state === "failed" && <Failure error={props.inbox.error} />}
      {!inbox && props.inbox.state === "loading" && <p className="quiet">{say("inbox.loading")}</p>}
      {inbox && cards.length === 0 && <p className="quiet">{say("inbox.empty")}</p>}
      {cards.flatMap((card) =>
        card.todos.map((t) => <TodoCard key={t.todo.id} item={t} card={card} onResolved={resolved} />),
      )}
      {delegation && !props.sampled && (
        <p className="quiet">
          <Link to={{ name: "decided" }}>{say("decided.link")}</Link>
        </p>
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
  const suggested = suggestedSide(item, sides);
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
      <h2>
        <Link to={{ name: "todo", id: item.todo.id }}>{factOf(say, item, card)}</Link>
      </h2>
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
      {item.comment && <p className="quiet">{item.comment.comment.body.slice(0, 160)}</p>}
      {item.left && <LeftMark reason={item.left.reason} />}
      {suggested && (
        <p className="suggest">
          {item.suggestion
            ? say("inbox.suggested_because", {
                value: choiceText(say, suggested.choice),
                reason: item.suggestion.reason,
              })
            : say("inbox.suggested", { value: choiceText(say, suggested.choice), title: titleOf(suggested) })}
        </p>
      )}
      {!suggested && item.suggestion && (
        <p className="suggest">{say("inbox.suggested_reason", { reason: item.suggestion.reason })}</p>
      )}
      {failure && <Failure error={failure} />}
      <div className="actions">
        <Link to={{ name: "todo", id: item.todo.id }}>{say("inbox.open")}</Link>
        {suggested ? (
          <button type="button" className="primary" disabled={busy} onClick={() => resolve(suggested)}>
            {say("inbox.confirm", { value: choiceText(say, suggested.choice) })}
          </button>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={() => resolve(undefined)}>
            {say("inbox.acknowledge")}
          </button>
        )}
      </div>
    </article>
  );
}

/** Why the assistant left a todo to the person, in the person's language. */
function LeftMark(props: { reason: string }) {
  const { say } = useWords();
  return (
    <p className="left-mark">
      <span className="tag">{say("decide.left")}</span> <span className="quiet">{props.reason}</span>
    </p>
  );
}

/** One conflict, both sides first, then the person's choice. */
export function DecisionScreen(props: { id: string; inbox: Loaded<Inbox>; onChanged: () => void }) {
  const { say } = useWords();
  const inbox = useLatest(props.inbox);
  const [outcome, setOutcome] = useState<Outcome>();
  const fetched = useLoad(`todo:${props.id}`, () =>
    document.documentElement.dataset.routes === "hash" ? Promise.resolve(undefined) : api.todo(props.id),
  );
  const found =
    (inbox?.cards ?? []).flatMap((card) =>
      card.todos.filter((t) => t.todo.id === props.id).map((item) => ({ item, card })),
    )[0] ??
    (fetched.state === "done" && fetched.value
      ? {
          item: fetched.value,
          card: { todos: [fetched.value], kind: "review" as const, batch_key: fetched.value.todo.batch_key ?? "" },
        }
      : undefined);
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
        {fetched.state === "failed" && <Failure error={fetched.error} />}
        <p className="quiet">{inbox ? say("decision.not_found") : say("inbox.loading")}</p>
      </main>
    );
  }
  if (!sidesOf(found.item).length || !["open", "in_progress"].includes(found.item.todo.status))
    return <Review item={found.item} card={found.card} onChanged={props.onChanged} />;
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
  const suggested = suggestedSide(item, sides);
  const [picked, setPicked] = useState(suggested?.choice.key);
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
        {item.todo.detail && <p className="todo-detail">{item.todo.detail}</p>}
        {item.left && <LeftMark reason={item.left.reason} />}
        {item.suggestion && <p className="suggest">{item.suggestion.reason}</p>}
        <div className="sides">
          {sides.map((s) => (
            <section key={s.choice.key} className="side">
              <div className="side-value">{value(s)}</div>
              {s.statement?.citations[0] ? (
                <Link to={{ ...citedAt(s.statement.citations[0]), todo: item.todo.id }}>
                  {say("quote.title", { title: titleOf(s) })}
                </Link>
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
              {s === suggested && <span className="tag">{say("decision.suggested")}</span>}
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

/** All todo kinds open with their source context, including closed source discussions. */
function Review(props: { item: InboxTodo; card: InboxCard; onChanged: () => void }) {
  const { say } = useWords();
  const { item } = props;
  const [status, setStatus] = useState(item.todo.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failureOf>>();
  const comment = item.comment;
  const finish = (next: "done" | "dismissed") => {
    setBusy(true);
    api
      .resolve(item.todo.id, { status: next })
      .then(
        (todo) => {
          setStatus(todo.status);
          props.onChanged();
        },
        (e: unknown) => setError(failureOf(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <main className="centre">
      <Crumbs>
        {[
          <Link key="back" to={{ name: "inbox" }}>
            {say("inbox.title")}
          </Link>,
          factOf(say, item, props.card),
        ]}
      </Crumbs>
      <h1 className="title">{factOf(say, item, props.card)}</h1>
      <p className="quiet">
        {say(`todo.${item.todo.kind}`)} · {say("decision.status", { status: say(`discussion.${status}`) })}
      </p>
      {item.todo.detail && <p className="todo-detail">{item.todo.detail}</p>}
      <h2>{say("decision.context")}</h2>
      {comment && (
        <section className="side">
          <Link
            to={{
              name: "document",
              version: comment.comment.source_version_id,
              block: comment.comment.block_id,
              view: "original",
              todo: item.todo.id,
            }}
          >
            {comment.document_title}
          </Link>
          <blockquote>{comment.comment.quote}</blockquote>
          {comment.comment.replacement !== undefined && (
            <p>
              <b>{say("discussion.replacement")}</b> {comment.comment.replacement || say("discussion.delete")}
            </p>
          )}
          <p className="todo-detail">{comment.comment.body}</p>
        </section>
      )}
      {item.statements.map((s) => (
        <section className="side" key={s.unit_id}>
          <Standing value={s.standing} />
          <p>{s.snippet}</p>
          {s.citations.map((c) => (
            <p key={c.span_id}>
              <Link to={{ ...citedAt(c), todo: item.todo.id }}>{c.source_title}</Link>
              <blockquote>{c.quote}</blockquote>
            </p>
          ))}
        </section>
      ))}
      {!comment && !item.statements.length && <p className="quiet">{say("decision.no_context")}</p>}
      {error && <Failure error={error} />}
      {["open", "in_progress"].includes(status) && (
        <>
          <p className="quiet">{say("decision.review_note")}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => finish("done")}>
              {say("decision.reviewed")}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => finish("dismissed")}>
              {say("decision.dismiss")}
            </button>
          </div>
        </>
      )}
      <Link to={{ name: "inbox" }}>{say("decision.back")}</Link>
    </main>
  );
}
