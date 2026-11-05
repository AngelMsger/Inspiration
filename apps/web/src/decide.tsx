// Decide for me on screen: the press at the top of the inbox that lets the assistant decide card
// by card, the offer to always decide routine reviews and conflicts and its pause, the decisions
// with their reasons and Undo, and the week's Decided for you. The engine decides with the
// member's rights and leaves the rest with why; the page shows both, never more.

import type { Decided, Delegation, InboxCard, TodoDecision } from "@inspiration/contracts";
import { useRef, useState } from "react";
import { api, type Library, useLoad } from "./api.ts";
import { chosenText, decideCards, decisionFact, toDecide } from "./decide.ts";
import { Crumbs, Failure, formatDate, useChange } from "./parts.tsx";
import { Link } from "./route.tsx";
import { weekOf } from "./todos.ts";
import { useWords } from "./words.ts";

/** One press that lets the assistant decide every card it may, in the inbox's order. */
export function DecideBar(props: { cards: readonly InboxCard[]; onCard: (d: Decided) => void; onDone: () => void }) {
  const { say } = useWords();
  // The inbox is read again even when a card fails, since the cards before it were decided.
  const { failure, busy, run } = useChange(() => undefined);
  const cards = toDecide(props.cards);
  if (cards.length === 0 && !failure) return null;
  return (
    <div className="decide-bar">
      <div className="decide-row">
        <button
          type="button"
          className="primary"
          disabled={busy || cards.length === 0}
          onClick={() => run(() => decideCards(cards, api.decide, props.onCard).finally(props.onDone))}
        >
          {busy ? say("decide.deciding") : say("decide.button")}
        </button>
        <span className="quiet">{say("decide.hint")}</span>
      </div>
      {failure && <Failure error={failure} />}
    </div>
  );
}

/** The standing Decide for me: offered while unset, else whether it is on, with a pause or a restart. */
export function AlwaysDecide(props: { delegation: Delegation; onChanged: () => void }) {
  const { say } = useWords();
  const { failure, busy, run } = useChange(props.onChanged);
  const set = (state: "on" | "paused") => run(() => api.setDelegation(state));
  const { state, paused_reason } = props.delegation;
  if (state === "unset") {
    return (
      <section className="decide-offer" aria-label={say("always.offer")}>
        <b>{say("always.offer")}</b>
        <p className="quiet">{say("always.offer_hint")}</p>
        {failure && <Failure error={failure} />}
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => set("on")}>
            {say("always.turn_on")}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => set("paused")}>
            {say("always.not_now")}
          </button>
        </div>
      </section>
    );
  }
  const line = state === "on" ? "always.on" : paused_reason === "undone" ? "always.paused_undone" : "always.paused";
  return (
    <div className={paused_reason === "undone" && state === "paused" ? "always always-undone" : "always quiet"}>
      <span>{say(line)}</span>
      <button
        type="button"
        className="link-button"
        disabled={busy}
        onClick={() => set(state === "on" ? "paused" : "on")}
      >
        {state === "on" ? say("always.pause") : say("always.resume")}
      </button>
      {failure && <Failure error={failure} />}
    </div>
  );
}

/** A decision the assistant made, with its reason and Undo, until it is undone. */
export function DecidedLine(props: { decision: TodoDecision; fact: string; when?: boolean; onUndone: () => void }) {
  const { say, tag } = useWords();
  const { failure, busy, run } = useChange(props.onUndone);
  const { decision } = props;
  return (
    <div className={decision.undone_at ? "decided-line decided-undone" : "decided-line"}>
      <p>
        <span className={`kind kind-${decision.todo.kind}`}>{say(`todo.${decision.todo.kind}`)}</span>{" "}
        {say("decide.line", { fact: props.fact, choice: chosenText(say, decision) })}
      </p>
      <p className="quiet">{decision.reason}</p>
      {props.when && (
        <p className="quiet">
          {[say(`decided.via.${decision.via}`), formatDate(tag, decision.decided_at, true)].join(" · ")}
        </p>
      )}
      {failure && <Failure error={failure} />}
      {decision.undone_at ? (
        <span className="tag">{say("decided.undone")}</span>
      ) : (
        <div>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => run(() => api.undo(decision.id))}
          >
            {busy ? say("decide.undoing") : say("decide.undo")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The decisions of this visit to the inbox, folded under how many were decided and left. */
export function DecidedFold(props: {
  decisions: { decision: TodoDecision; fact: string }[];
  left: number;
  onUndone: (decision: TodoDecision) => void;
}) {
  const { say } = useWords();
  return (
    <details className="decided-fold">
      <summary>{say("decide.summary", { decided: props.decisions.length, left: props.left })}</summary>
      {props.decisions.map((d) => (
        <DecidedLine
          key={d.decision.id}
          decision={d.decision}
          fact={d.fact}
          onUndone={() => props.onUndone(d.decision)}
        />
      ))}
    </details>
  );
}

/** What the assistant decided for the member this week, the undone too; it asks for nothing. */
export function DecidedScreen(props: { library: Library; onChanged: () => void }) {
  const { say } = useWords();
  const [version, setVersion] = useState(0);
  const week = useLoad(`decided:${version}`, api.decidedWeek);
  const last = useRef<typeof week>(undefined);
  if (week.state !== "loading") last.current = week;
  const shown = week.state === "loading" ? last.current : week;
  const topics = [...props.library.topics.values()].flatMap((l) => l.topics);
  const undone = () => {
    setVersion((v) => v + 1);
    props.onChanged();
  };
  return (
    <main className="centre">
      <Crumbs>
        {[
          <Link key="inbox" to={{ name: "inbox" }}>
            {say("inbox.title")}
          </Link>,
          say("decided.title"),
        ]}
      </Crumbs>
      <div className="heading">
        <h1 className="title">{say("decided.title")}</h1>
      </div>
      {shown?.state === "failed" && <Failure error={shown.error} />}
      {!shown && <p className="quiet">{say("inbox.loading")}</p>}
      {shown?.state === "done" && (
        <>
          <p className="lede">{say("decided.lede", { week: weekOf(shown.value.week) })}</p>
          <p className="quiet">
            {say("decided.counts", {
              decided: shown.value.decisions.length,
              left: shown.value.left,
              undone: shown.value.undone,
            })}
          </p>
          {shown.value.decisions.length === 0 && <p className="quiet">{say("decided.none")}</p>}
          {shown.value.decisions.map((d) => (
            <DecidedLine
              key={d.id}
              decision={d}
              fact={decisionFact(say, d, undefined, topics)}
              when
              onUndone={undone}
            />
          ))}
        </>
      )}
    </main>
  );
}
