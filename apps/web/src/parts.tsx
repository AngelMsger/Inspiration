// Small pieces every screen uses: breadcrumbs, a standing chip, dates, failures.

import type { SlotStanding } from "@inspiration/contracts";
import { Fragment, type ReactNode } from "react";
import type { ApiFailure } from "./api.ts";
import { type Tag, useWords } from "./words.ts";

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

export function Failure(props: { error: ApiFailure; notFound?: string }) {
  const { say } = useWords();
  const text =
    props.error.status === 404 && props.notFound
      ? props.notFound
      : props.error.status === 502 || props.error.status === 0
        ? say("failure.engine")
        : say("failure.other", { message: props.error.message });
  return <p className="failure">{text}</p>;
}
