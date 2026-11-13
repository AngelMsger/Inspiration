// A source quote is captured before focus moves to the composer. Both reading modes use it.
import type { DocumentComment, DocumentView, NewDocumentComment, SourceBlock } from "@inspiration/contracts";
import { useEffect, useRef, useState } from "react";
import { api, failureOf, useLoad } from "./api.ts";
import { Failure, formatDate } from "./parts.tsx";
import { Link } from "./route.tsx";
import { useWords } from "./words.ts";

export type SelectionAnchor = Pick<NewDocumentComment, "block_id" | "start" | "end" | "quote">;

export function blockAnchor(block: SourceBlock): SelectionAnchor {
  return { block_id: block.id, start: 0, end: block.text.length, quote: block.text };
}

/** A selection must be inside one source block, with offsets in its exact source text. */
export function selectedAnchor(blocks: SourceBlock[]): SelectionAnchor | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const element = (
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  )?.closest<HTMLElement>("[data-source-block]");
  if (!element?.contains(range.endContainer)) return;
  const block = blocks.find((b) => b.id === element.dataset.sourceBlock);
  if (!block) return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = Number(element.dataset.sourceStart ?? 0) + prefix.toString().length;
  const quote = range.toString();
  if (!quote.trim() || block.text.slice(start, start + quote.length) !== quote) return;
  return { block_id: block.id, start, end: start + quote.length, quote };
}

export function Discussion(props: {
  view: DocumentView;
  anchor: SelectionAnchor;
  member: string;
  allowed: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { say, tag } = useWords();
  const [body, setBody] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    composer.current?.focus({ preventScroll: true });
  }, []);
  const [correction, setCorrection] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [request, setRequest] = useState(() => crypto.randomUUID());
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failureOf>>();
  const [saved, setSaved] = useState<DocumentComment>();
  const comments = useLoad(`${props.view.version.id}:${generation}`, () =>
    document.documentElement.dataset.routes === "hash" ? Promise.resolve([]) : api.comments(props.view.version.id),
  );
  const block = props.view.blocks.find((b) => b.id === props.anchor.block_id);
  const relatedBlocks = new Set(
    block?.parent_id
      ? props.view.blocks.filter((b) => b.parent_id === block.parent_id).map((b) => b.id)
      : [props.anchor.block_id],
  );
  const recorded = document.documentElement.dataset.routes === "hash";
  const submit = () => {
    setBusy(true);
    setError(undefined);
    api
      .comment({
        ...props.anchor,
        source_version_id: props.view.version.id,
        request_id: request,
        body: body.trim(),
        ...(correction && { replacement }),
      })
      .then(
        (comment) => {
          setSaved(comment);
          setBody("");
          setReplacement("");
          setRequest(crypto.randomUUID());
          setGeneration((n) => n + 1);
          props.onChanged();
        },
        (e: unknown) => setError(failureOf(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <aside className="panel discussion" aria-label={say("discussion.title")}>
      <div className="panel-head">
        <b className="panel-title">{say("discussion.title")}</b>
        <button type="button" className="plain" aria-label={say("doc.close")} onClick={props.onClose}>
          ×
        </button>
      </div>
      <blockquote>{props.anchor.quote}</blockquote>
      <p className="quiet">
        {say("discussion.version", {
          version: props.view.version.version.external_version ?? formatDate(tag, props.view.version.fetched_at),
        })}
      </p>
      {recorded ? (
        <p>{say("discussion.recorded")}</p>
      ) : !props.allowed ? (
        <p>{say("discussion.permission")}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && body.trim()) submit();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              <input
                type="checkbox"
                checked={correction}
                onChange={(e) => {
                  setCorrection(e.target.checked);
                  setRequest(crypto.randomUUID());
                }}
              />{" "}
              {say("discussion.correction")}
            </label>
            {correction && (
              <label>
                {say("discussion.replacement")}
                <textarea
                  value={replacement}
                  maxLength={8000}
                  onChange={(e) => {
                    setReplacement(e.target.value);
                    setRequest(crypto.randomUUID());
                  }}
                />
              </label>
            )}
            <label>
              {say(correction ? "discussion.reason" : "discussion.body")}
              <textarea
                ref={composer}
                value={body}
                required
                maxLength={8000}
                onChange={(e) => {
                  setBody(e.target.value);
                  setRequest(crypto.randomUUID());
                }}
              />
            </label>
            <p className="quiet">{say("discussion.proposal")}</p>
            <button className="primary" type="submit" disabled={!body.trim()}>
              {say(busy ? "discussion.saving" : "discussion.send")}
            </button>
          </fieldset>
        </form>
      )}
      {error && <Failure error={error} />}
      {saved && <p role="status">{say("discussion.saved")}</p>}
      {!recorded && comments.state === "failed" && <Failure error={comments.error} />}
      {comments.state === "done" &&
        comments.value
          .filter((c) => relatedBlocks.has(c.comment.block_id))
          .map((c) => (
            <section key={c.id} className="discussion-entry">
              <div className="quiet">
                {formatDate(tag, c.created_at)} · {say(`discussion.${c.status ?? "open"}`)}
              </div>
              <blockquote>{c.comment.quote}</blockquote>
              {c.comment.replacement !== undefined && (
                <p>
                  <b>{say("discussion.replacement")}</b> {c.comment.replacement || say("discussion.delete")}
                </p>
              )}
              <p>{c.comment.body}</p>
              {c.todo_id && c.assignee_id === props.member && (
                <Link to={{ name: "todo", id: c.todo_id }}>{say("inbox.open")}</Link>
              )}
              {c.assignee_id && (
                <p className="quiet">
                  {say(c.assignee_id === props.member ? "discussion.assigned_you" : "discussion.assigned_owner")}
                </p>
              )}
            </section>
          ))}
    </aside>
  );
}
