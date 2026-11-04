// The guide a snapshot shows along the bottom of the app: the demo script's step opened last,
// what to look at or do there, and the next step, each opened as the person who takes it. All
// the steps are a click away, and so is starting over. It reloads the page to change person,
// since the app reads whom it acts as once, and speaks the language the app shows.

import { useEffect, useState } from "react";
import { MOVED, type Place, type Recording, type ScriptStep, savedPlace, savePlace } from "./replay.ts";
import { chooseTag, type Tag, wordsOf } from "./words.ts";

/** Open a step: its page, as its person, reloading when the person changes. */
function go(recording: Recording, index: number): Place {
  const step = recording.steps[index] as ScriptStep;
  const place = savedPlace(recording);
  const next = { ...place, member: step.as, step: index };
  savePlace(next);
  location.hash = step.open;
  if (step.as !== place.member) location.reload();
  return next;
}

function restart(): void {
  savePlace(undefined);
  location.hash = "/";
  location.reload();
}

const textOf = (step: ScriptStep, tag: Tag) => step.text[tag] ?? step.text.en ?? Object.values(step.text)[0];

export function Guide(props: { recording: Recording }) {
  const { recording } = props;
  const [place, setPlace] = useState(() => savedPlace(recording));
  const [shown, setShown] = useState(true);
  const [all, setAll] = useState(false);
  // The app marks its language on <html> once it knows whom it acts as.
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => {
    const moved = () => setPlace(savedPlace(recording));
    window.addEventListener(MOVED, moved);
    return () => window.removeEventListener(MOVED, moved);
  }, [recording]);
  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => setLang(html.lang));
    observer.observe(html, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);
  const name = (member: string) => recording.people.people.find((p) => p.member === member)?.name ?? member;
  const tag = chooseTag(lang, recording.people.people.find((p) => p.member === place.member)?.locale);
  const say = wordsOf(tag);
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
              <button type="button" className="guide-link" onClick={() => setPlace(go(recording, i))}>
                {say("guide.open", { name: name(step.as) })}
              </button>
              {done[i] && <span className="quiet"> · {say("guide.done")}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="guide-bar">
        <div className="guide-now">
          <span className="quiet">
            {current ? say("guide.step", { n: at + 1, count, name: name(current.as) }) : say("guide.title")}
            {done[at] && ` · ${say("guide.done")}`}
          </span>
          <p>
            {current ? textOf(current, tag) : say("guide.about", { date: recording.recorded_at.slice(0, 10), count })}
          </p>
        </div>
        <div className="guide-actions">
          {next ? (
            <button type="button" className="primary" onClick={() => setPlace(go(recording, at + 1))}>
              {say(current ? "guide.next" : "guide.start", { name: name(next.as) })}
            </button>
          ) : (
            <button type="button" className="primary" onClick={restart}>
              {say("guide.restart")}
            </button>
          )}
          <button type="button" className="guide-link" onClick={() => setAll(!all)}>
            {say(all ? "guide.fewer" : "guide.all")}
          </button>
          {current && next && (
            <button type="button" className="guide-link" onClick={restart}>
              {say("guide.restart")}
            </button>
          )}
          <button type="button" className="guide-link" onClick={() => setShown(false)}>
            {say("guide.hide")}
          </button>
        </div>
      </div>
    </aside>
  );
}
