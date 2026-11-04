// The guide a snapshot shows along the bottom of the app: the demo script's step opened last,
// what to look at or do there, and the next step, each opened as the person who takes it. All
// the steps are a click away, and so is starting over. It speaks the language the app shows.

import { useEffect, useState } from "react";
import { MOVED, type Place, type Recording, type Replay, type ScriptStep, startOf } from "./replay.ts";
import { chooseTag, type Tag, wordsOf } from "./words.ts";

const textOf = (step: ScriptStep, tag: Tag) => step.text[tag] ?? step.text.en ?? Object.values(step.text)[0];

export function Guide(props: {
  recording: Recording;
  replay: Replay;
  /** Have the app read the demo again, as the person and state it is at now. */
  onRestart: () => void;
}) {
  const { recording, replay } = props;
  const [place, setPlace] = useState(replay.place);
  const [shown, setShown] = useState(true);
  const [all, setAll] = useState(false);
  // The app marks its language on <html> once it knows whom it acts as.
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => {
    const moved = () => setPlace(replay.place());
    window.addEventListener(MOVED, moved);
    return () => window.removeEventListener(MOVED, moved);
  }, [replay]);
  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => setLang(html.lang));
    observer.observe(html, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);
  const name = (member: string) => recording.people.people.find((p) => p.member === member)?.name ?? member;
  const tag = chooseTag(lang, recording.people.people.find((p) => p.member === place.member)?.locale);
  const say = wordsOf(tag);

  const open = (next: Place, address: string, restart: boolean) => {
    replay.moveTo(next);
    location.hash = address;
    if (restart) props.onRestart();
  };
  // A step opens the state the script recorded it in, the one its earlier steps' actions lead
  // to, whether or not the visitor took them, so a skipped or repeated action never strands a step.
  const go = (index: number) => {
    const step = recording.steps[index] as ScriptStep;
    const state = recording.steps.slice(0, index).filter((s) => s.do).length;
    const now = replay.place();
    setAll(false);
    open({ state, member: step.as, step: index }, step.open, step.as !== now.member || state !== now.state);
  };
  const startOver = () => open(startOf(recording), "/", true);

  if (!shown) {
    return (
      <button type="button" className="guide-show" onClick={() => setShown(true)}>
        {say("guide.title")}
      </button>
    );
  }
  // A step's action is done once the demo is past the state it leads to.
  let actions = 0;
  const done = recording.steps.map((step) => (step.do ? place.state > actions++ : false));
  const count = recording.steps.length;
  const at = place.step ?? -1;
  const current = recording.steps[at];
  const next = recording.steps[at + 1];
  return (
    <aside className="guide" aria-label={say("guide.title")}>
      {all && (
        <ol className="guide-all">
          {recording.steps.map((step, i) => (
            <li
              key={`${step.open} ${Object.values(step.text).join(" ")}`}
              className={i === at ? "guide-at" : undefined}
            >
              <p>{textOf(step, tag)}</p>
              <button type="button" className="guide-link" onClick={() => go(i)}>
                {say("guide.open", { name: name(step.as) })}
              </button>
              {done[i] && <span className="quiet"> · {say("guide.done")}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="guide-bar">
        <div key={at} className="guide-now">
          <span className="quiet">
            {current ? say("guide.step", { n: at + 1, count, name: name(current.as) }) : say("guide.title")}
            {done[at] && ` · ${say("guide.done")}`}
          </span>
          <p>
            {current ? textOf(current, tag) : say("guide.about", { date: recording.recorded_at.slice(0, 10), count })}
          </p>
        </div>
        {/* The main button comes last and keeps one place and size, so a visitor who clicks
            through without moving the pointer never lands on a link that moved under it. */}
        <div className="guide-actions">
          <button type="button" className="guide-link" onClick={() => setAll(!all)}>
            {say(all ? "guide.fewer" : "guide.all")}
          </button>
          {current && next && (
            <button type="button" className="guide-link" onClick={startOver}>
              {say("guide.restart")}
            </button>
          )}
          <button type="button" className="guide-link" onClick={() => setShown(false)}>
            {say("guide.hide")}
          </button>
          {next ? (
            <button type="button" className="primary guide-go" onClick={() => go(at + 1)}>
              {say(current ? "guide.next" : "guide.start", { name: name(next.as) })}
            </button>
          ) : (
            <button type="button" className="primary guide-go" onClick={startOver}>
              {say("guide.restart")}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
