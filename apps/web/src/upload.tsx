// Uploading files and folders into a space from its Documents: two buttons, or a drop on the
// list. Each space's uploads are kept while the page is open, so leaving the Documents and
// coming back shows how they went; they go on meanwhile (uploads.ts sends them).

import type { DocumentTreeNode, SpaceEntry } from "@inspiration/contracts";
import { type DragEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { type Outcome, type Picked, plan, READABLE, reasonOf, send, type Upload } from "./uploads.ts";
import { type Say, useWords } from "./words.ts";

/** The source a space's uploads go into; the engine makes it with the space's first upload. */
export const UPLOADS = "upload";

/** A failure that sending again may mend: not the engine's refusal of the file itself. */
const retriable = (o: Outcome) => o.state === "failed" && (o.reason === "network" || o.reason === "other");

const kept = new Map<string, Upload[]>();
const listeners = new Set<() => void>();
const NONE: Upload[] = [];

function keep(space: string, uploads: Upload[]) {
  kept.set(space, uploads);
  for (const l of listeners) l();
}

function useUploads(space: string): Upload[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => kept.get(space) ?? NONE,
  );
}

/** Sends `batch`, uploads of `space` that wait; `onSent` hears when any changed what the space holds. */
async function run(space: string, batch: Upload[], onSent: () => void) {
  let changed = false;
  await send(
    batch,
    (u) => api.putFile(space, u.path, u.file),
    (i, outcome) => {
      const sent = batch[i] as Upload;
      if (outcome.state === "added" || outcome.state === "version") changed = true;
      // The same file at the same path: one sent again since is another line.
      const same = (u: Upload) => u.file === sent.file && u.path.join("/") === sent.path.join("/");
      keep(
        space,
        (kept.get(space) ?? []).map((u) => (same(u) ? { ...u, outcome } : u)),
      );
    },
  );
  if (changed) onSent();
}

/** The document paths (external IDs) already in the space's uploads. */
export function uploadedPaths(sources: readonly DocumentTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (n: DocumentTreeNode) => {
    if (n.document) paths.add(n.document.external_id);
    for (const c of n.children ?? []) walk(c);
  };
  for (const s of sources) if (s.source_type === UPLOADS) walk(s);
  return paths;
}

/** Every file below a dropped folder, with its path from the drop. */
async function droppedFiles(items: DataTransferItemList): Promise<Picked[]> {
  const out: Picked[] = [];
  // The items are only readable during the drop, so each becomes an entry, or a file, at once.
  const entries: FileSystemEntry[] = [];
  for (const item of [...items]) {
    const entry = item.kind === "file" ? item.webkitGetAsEntry() : null;
    const file = entry ? null : item.getAsFile();
    if (entry) entries.push(entry);
    else if (file) out.push({ file, relative: file.name });
  }
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      out.push({ file, relative: entry.fullPath.replace(/^\//, "") });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A folder is read in pages until one comes back empty.
    for (;;) {
      const page = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (page.length === 0) return;
      for (const e of page) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/**
 * The Documents' upload controls and the outcomes of what was sent. Files go into `folder` of
 * the space's uploads; `children` is the list a drop lands on.
 */
export function Uploader(props: {
  space: SpaceEntry;
  sources: readonly DocumentTreeNode[];
  folder: string[];
  onSent: () => void;
  children: ReactNode;
}) {
  const { say } = useWords();
  const uploads = useUploads(props.space.id);
  const [over, setOver] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const add = (picked: Picked[]) => {
    const existing = uploadedPaths(props.sources);
    const next = plan(picked, props.folder, (p) => existing.has(p.join("/")));
    if (next.length === 0) return;
    const sent = new Set(next.map((u) => u.path.join("/")));
    // A file sent again replaces its line.
    const now = kept.get(props.space.id) ?? [];
    keep(props.space.id, [...now.filter((u) => !sent.has(u.path.join("/"))), ...next]);
    void run(props.space.id, next, props.onSent);
  };
  const picked = (input: HTMLInputElement | null) => {
    const list = [...(input?.files ?? [])].map((file) => ({ file, relative: file.webkitRelativePath || file.name }));
    if (input) input.value = "";
    add(list);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void droppedFiles(e.dataTransfer.items).then(add);
  };
  const retry = () => {
    const now = kept.get(props.space.id) ?? [];
    const again = now.map((u) => (retriable(u.outcome) ? { ...u, outcome: { state: "waiting" } as Outcome } : u));
    keep(props.space.id, again);
    void run(
      props.space.id,
      again.filter((u, i) => u !== now[i]),
      props.onSent,
    );
  };
  const clear = () =>
    keep(
      props.space.id,
      (kept.get(props.space.id) ?? []).filter((u) => u.outcome.state === "waiting" || u.outcome.state === "sending"),
    );
  const where = props.folder.at(-1) ?? say("uploads.name");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the two buttons do the same by keyboard
    <section
      className={over ? "uploads dropping" : "uploads"}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node | null) || setOver(false)}
      onDrop={drop}
    >
      <div className="upload-actions">
        <button type="button" className="secondary" onClick={() => files.current?.click()}>
          {say("upload.files")}
        </button>
        <button type="button" className="secondary" onClick={() => folder.current?.click()}>
          {say("upload.folder")}
        </button>
        <span className="quiet">{say("upload.hint", { folder: where })}</span>
        <input ref={files} type="file" multiple hidden accept={READABLE.join(",")} onChange={(e) => picked(e.target)} />
        <input
          ref={(el) => {
            folder.current = el;
            el?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          hidden
          onChange={(e) => picked(e.target)}
        />
      </div>
      {uploads.length > 0 && <Outcomes uploads={uploads} onRetry={retry} onClear={clear} />}
      {props.children}
    </section>
  );
}

/** The failed uploads by why they failed, each why once with its files' paths. */
function byReason(uploads: Upload[], say: Say): { why: string; paths: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const u of uploads) {
    if (u.outcome.state !== "failed") continue;
    const why = say(`upload.reason.${u.outcome.reason}`, { message: u.outcome.message });
    groups.set(why, [...(groups.get(why) ?? []), u.path.join("/")]);
  }
  return [...groups].map(([why, paths]) => ({ why, paths }));
}

function Outcomes(props: { uploads: Upload[]; onRetry: () => void; onClear: () => void }) {
  const { say } = useWords();
  const count = (state: Outcome["state"]) => props.uploads.filter((u) => u.outcome.state === state).length;
  const going = count("waiting") + count("sending");
  const failed = props.uploads.filter((u) => u.outcome.state === "failed");
  const done = [
    ["added", count("added")],
    ["version", count("version")],
    ["same", count("same")],
    ["failed", failed.length],
  ] as const;
  return (
    <div className="upload-outcomes" aria-live="polite">
      <div className="upload-summary">
        <span>
          {going > 0
            ? say("upload.sending", { done: props.uploads.length - going, count: props.uploads.length })
            : done
                .filter(([, n]) => n > 0)
                .map(([state, n]) => say(`upload.${state}`, { count: n }))
                .join(say("list.mark"))}
        </span>
        {going === 0 && failed.some((u) => retriable(u.outcome)) && (
          <button type="button" className="link-button" onClick={props.onRetry}>
            {say("upload.retry")}
          </button>
        )}
        {going === 0 && (
          <button type="button" className="link-button" onClick={props.onClear}>
            {say("upload.clear")}
          </button>
        )}
      </div>
      {failed.length > 0 && (
        <ul className="upload-failures">
          {byReason(failed, say).map((g) => (
            <li key={g.why}>
              <span>{g.why}</span>
              <span className="quiet">{g.paths.join(say("list.mark"))}</span>
            </li>
          ))}
        </ul>
      )}
      {going === 0 && count("added") + count("version") > 0 && <p className="quiet">{say("upload.reading")}</p>}
    </div>
  );
}

/**
 * A new version of an uploaded document at `path` of the space's uploads, from a file of the same
 * kind, since the engine reads a file by its name's extension. `onChanged` hears when it made one.
 */
export function NewVersion(props: { space: string; path: string; onChanged: () => void }) {
  const { say } = useWords();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ sending?: boolean; note?: string }>({});
  const ext = props.path.slice(props.path.lastIndexOf(".")).toLowerCase();
  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(ext)) return setState({ note: say("upload.other_kind", { ext }) });
    setState({ sending: true });
    try {
      const written = await api.putFile(props.space, props.path.split("/"), file);
      setState(written.changed ? {} : { note: say("upload.same_version") });
      if (written.changed) props.onChanged();
    } catch (e) {
      const why = reasonOf(e);
      setState({ note: say(`upload.reason.${why.reason}`, { message: why.message }) });
    }
  };
  return (
    <span className="new-version">
      <button type="button" className="link-button" disabled={state.sending} onClick={() => input.current?.click()}>
        {state.sending ? say("upload.sending_one") : say("upload.new_version")}
      </button>
      <input ref={input} type="file" hidden accept={ext} onChange={(e) => void pick(e.target.files?.[0])} />
      {state.note && <span className="quiet">{state.note}</span>}
    </span>
  );
}
