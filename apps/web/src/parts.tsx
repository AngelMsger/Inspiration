// Small pieces every screen uses: breadcrumbs, a standing chip, dates, failures, a change that
// asks once more before it acts, and a value to copy.

import type { SlotStanding } from "@inspiration/contracts";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { type ApiFailure, failureOf } from "./api.ts";
import { type Say, type Tag, useWords } from "./words.ts";

/** Breadcrumbs from the area to the thing shown; the last one is where you are. */
export function Crumbs(props: { back?: ReactNode; children: ReactNode[] }) {
  const { say } = useWords();
  const items = props.children.filter(Boolean);
  return (
    <nav className="crumbs" aria-label={say("nav.label")}>
      {props.back && (
        <>
          {props.back}
          <span className="crumbs-bar" aria-hidden="true">
            |
          </span>
        </>
      )}
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are a fixed path, never reordered
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true"> › </span>}
          {i === items.length - 1 ? <span className="crumbs-here">{item}</span> : item}
        </Fragment>
      ))}
    </nav>
  );
}

/** Where a value stands with governance, for the values that need a reader's attention. */
export function Standing(props: { value: SlotStanding | undefined; quiet?: boolean }) {
  const { say } = useWords();
  if (!props.value || (props.quiet && props.value === "holds")) return null;
  return <span className={`standing standing-${props.value}`}>{say(`standing.${props.value}`)}</span>;
}

/** A day, or with `time` the minute too, for changes that happen within a day. */
export function formatDate(tag: Tag, iso: string | undefined, time = false): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(tag === "zh" ? "zh-CN" : tag, {
    dateStyle: "medium",
    ...(time && { timeStyle: "short" }),
  }).format(new Date(iso));
}

/** In a snapshot, a call its recording lacks; for a question, the ones it can answer. */
function notRecorded(say: Say, questions: string): string {
  const can = questions
    ? say("failure.recorded_questions", { questions: questions.split("\n").join(say("list.mark")) })
    : "";
  return `${say("failure.not_recorded")}${can}`;
}

export function Failure(props: { error: ApiFailure; notFound?: string }) {
  const { say } = useWords();
  const text =
    props.error.code === "not_recorded"
      ? notRecorded(say, props.error.message)
      : props.error.code === "demo_script"
        ? say("failure.demo_script")
        : props.error.status === 404 && props.notFound
          ? props.notFound
          : props.error.status === 502 || props.error.status === 0
            ? say("failure.engine")
            : say("failure.other", { message: props.error.message });
  return <p className="failure">{text}</p>;
}

/** A change the page asked for, and what went wrong with it. */
export function useChange(onChanged: () => void) {
  const [failure, setFailure] = useState<ApiFailure>();
  const [busy, setBusy] = useState(false);
  const run = (change: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(undefined);
    return change()
      .then(onChanged, (e: unknown) => setFailure(failureOf(e)))
      .finally(() => setBusy(false));
  };
  return { failure, busy, run };
}

/** A button that asks once more before it acts, since the page cannot open a dialog. */
export function TwoStep(props: { label: string; confirm: string; disabled: boolean; onConfirm: () => void }) {
  const { say } = useWords();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="link-button" disabled={props.disabled} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <span className="two-step">
      <span>{props.confirm}</span>
      <button
        type="button"
        className="link-button danger"
        disabled={props.disabled}
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        {props.label}
      </button>
      <button type="button" className="link-button" onClick={() => setAsking(false)}>
        {say("action.cancel")}
      </button>
    </span>
  );
}

/**
 * A value to copy, such as a link or a secret. Where the page may not write the clipboard, the
 * value is selected for the person to copy; `lines` shows a long one, such as a command, whole.
 */
export function CopyField(props: { value: string; label: string; lines?: number }) {
  const { say } = useWords();
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(props.value).then(
      () => setCopied(true),
      () => field.current?.select(),
    );
  };
  const shared = {
    ref: field,
    readOnly: true,
    "aria-label": props.label,
    value: props.value,
    onFocus: (e: { target: { select: () => void } }) => e.target.select(),
  };
  return (
    <div className="made-link-row">
      {props.lines ? <textarea rows={props.lines} {...shared} /> : <input {...shared} />}
      <button type="button" className="secondary" onClick={copy}>
        {copied ? say("copy.done") : say("copy.button")}
      </button>
    </div>
  );
}
