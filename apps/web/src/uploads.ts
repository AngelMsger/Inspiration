// Files and folders going into a space's uploads, as the page sends them: one PUT per file at its
// path, a few at a time. The engine keeps one document per path; the same bytes again change
// nothing, so a file that failed on the way is sent again as it is, and other bytes at a path
// that holds a document make its new version (FileWritten).

import type { FileWritten, SpaceEntry } from "@inspiration/contracts";
import { failureOf } from "./api.ts";

/** The size a file may have; the engine answers 413 too_large above it. */
export const MAX_FILE = 50 * 1024 * 1024;

/**
 * The kinds the engine reads, by the name's extension; it answers 415 unsupported_type for any
 * other. The page checks first so that a folder's other files are not sent only to be refused.
 */
export const READABLE = [".md", ".markdown", ".txt", ".html", ".htm", ".csv", ".docx", ".pptx", ".xlsx", ".pdf"];

const readable = (name: string) => READABLE.some((ext) => name.toLowerCase().endsWith(ext));

/** The roles that may write into a space; viewers and commenters only read. */
const WRITERS = new Set<SpaceEntry["role"]>(["editor", "steward", "owner"]);

export const mayUpload = (space: SpaceEntry) => WRITERS.has(space.role);

/** A file as the page has it: its bytes, and its path below the folder it was dropped or picked in. */
export interface Picked {
  file: Blob;
  /** A folder's files carry their path inside it, `a/b.docx`; a single file just its name. */
  relative: string;
}

export type Outcome =
  | { state: "waiting" | "sending" }
  /** added is a new document, version a new version of one, same the bytes it already had. */
  | { state: "added" | "version" | "same" }
  | { state: "failed"; reason: Reason; message: string };

/** recorded is a snapshot of the demo, which answers only the calls it recorded. */
export type Reason = "too_large" | "unsupported" | "forbidden" | "network" | "recorded" | "other";

export interface Upload {
  /** The folders from the uploads' root to the file, its own name last. */
  path: string[];
  file: Blob;
  /** Whether a document was at the path before, so a change is its new version. */
  existed: boolean;
  outcome: Outcome;
}

/** Whether a file is the operating system's or an editor's, which a folder carries along unasked. */
const housekeeping = (name: string) =>
  name.startsWith(".") || name.startsWith("~$") || /^(thumbs\.db|desktop\.ini)$/i.test(name);

/**
 * The uploads that `picked` makes in `folder` of the space's uploads, in their order; a later
 * file at the same path wins. `exists` says whether a path already holds a document.
 */
export function plan(
  picked: readonly Picked[],
  folder: readonly string[],
  exists: (path: string[]) => boolean,
): Upload[] {
  const byPath = new Map<string, Upload>();
  for (const p of picked) {
    const names = p.relative.split("/").filter((n) => n !== "");
    if (names.length === 0 || names.some(housekeeping)) continue;
    const path = [...folder, ...names];
    const refused: Reason | undefined = !readable(names.at(-1) as string)
      ? "unsupported"
      : p.file.size > MAX_FILE
        ? "too_large"
        : undefined;
    const outcome: Outcome = refused ? { state: "failed", reason: refused, message: "" } : { state: "waiting" };
    byPath.set(path.join("/"), { path, file: p.file, existed: exists(path), outcome });
  }
  return [...byPath.values()];
}

/** Why a sent file failed, as the page says it. */
export function reasonOf(error: unknown): { reason: Reason; message: string } {
  const f = failureOf(error);
  const reason: Reason =
    f.status === 413 || f.code === "too_large"
      ? "too_large"
      : f.status === 415 || f.code === "unsupported_type"
        ? "unsupported"
        : f.status === 403
          ? "forbidden"
          : f.status === 0
            ? "network"
            : f.code === "not_recorded"
              ? "recorded"
              : "other";
  return { reason, message: f.message || `${f.status} ${f.code}` };
}

/** What a written file did to its path. */
export const outcomeOf = (upload: Upload, written: FileWritten): Outcome => ({
  state: !written.changed ? "same" : upload.existed ? "version" : "added",
});

/**
 * Sends every waiting upload through `put`, `at_once` at a time, and tells `report` each change
 * of outcome, by index. A network failure is sent again, `retries` times after a growing wait;
 * the engine's refusals are not.
 */
export async function send(
  uploads: readonly Upload[],
  put: (upload: Upload) => Promise<FileWritten>,
  report: (index: number, outcome: Outcome) => void,
  options: { atOnce?: number; retries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { atOnce = 3, retries = 2, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const queue = uploads.flatMap((u, i) => (u.outcome.state === "waiting" ? [i] : []));
  const one = async (i: number) => {
    const upload = uploads[i] as Upload;
    report(i, { state: "sending" });
    for (let attempt = 0; ; attempt++) {
      try {
        report(i, outcomeOf(upload, await put(upload)));
        return;
      } catch (e) {
        const why = reasonOf(e);
        if (why.reason !== "network" || attempt >= retries) {
          report(i, { state: "failed", ...why });
          return;
        }
        await wait(1000 * 2 ** attempt);
      }
    }
  };
  const worker = async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) await one(i);
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, queue.length) }, worker));
}
