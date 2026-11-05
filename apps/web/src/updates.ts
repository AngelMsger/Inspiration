/**
 * The demo's upstream edits, for the development backend (backend.ts). Each folder under
 * <corpus>/updates holds new versions of documents at their paths in the corpus, and an
 * update.yaml with a title, the source the documents are in, a question whose answer it
 * changes and the day it was saved. Putting one in copies its files over the corpus the
 * engine serves, dated that day as files.yaml dates the others, as someone saving them on the
 * drive would; the backend then syncs that source now, as the person the page acts as. The
 * day keeps a recording of the demo the same whichever day it is made. pnpm demo serves a
 * copy of the corpus, so the repository stays as it is.
 *
 *     GET  /api/demo/updates         {"updates": [Update, ...]}
 *     POST /api/demo/updates/:name   SyncReport, once the engine has read the new versions
 */

import { cp, readdir, readFile, utimes } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "yaml";

export interface Update {
  name: string;
  title: string;
  source: string;
  /** A question whose answer the update changes, to ask again once it is in. */
  question?: string;
  /** The day its documents were saved, YYYY-MM-DD. */
  modified?: string;
  /** Put in during this run of the demo. */
  applied: boolean;
}

const MANIFEST = "update.yaml";

export class Updates {
  readonly #dir: string;
  readonly #corpus: string;
  readonly #applied = new Set<string>();

  constructor(corpus: string) {
    this.#corpus = corpus;
    this.#dir = join(corpus, "updates");
  }

  async list(): Promise<Update[]> {
    const entries = await readdir(this.#dir, { withFileTypes: true }).catch(() => []);
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return (await Promise.all(names.map((n) => this.#read(n)))).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Copy an update's files over the corpus; RangeError for an update that is not there. */
  async apply(name: string): Promise<Update> {
    if (!(await this.list()).some((u) => u.name === name)) throw new RangeError(`no update ${name}`);
    const from = join(this.#dir, name);
    const update = await this.#read(name);
    const copied: string[] = [];
    await cp(from, this.#corpus, {
      recursive: true,
      filter: (path) => {
        if (path.endsWith(MANIFEST)) return false;
        copied.push(relative(from, path));
        return true;
      },
    });
    if (update.modified) {
      const at = new Date(`${update.modified}T12:00:00Z`);
      for (const path of copied) if (path) await utimes(join(this.#corpus, path), at, at);
    }
    this.#applied.add(name);
    return { ...update, applied: true };
  }

  async #read(name: string): Promise<Update> {
    const raw = parse(await readFile(join(this.#dir, name, MANIFEST), "utf8")) as Partial<Update> | null;
    if (typeof raw?.title !== "string" || typeof raw.source !== "string" || !raw.source.startsWith("src_")) {
      throw new RangeError(`${name}/${MANIFEST} does not name a title and a source`);
    }
    return {
      name,
      title: raw.title,
      source: raw.source,
      ...(typeof raw.question === "string" && { question: raw.question }),
      ...(typeof raw.modified === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.modified) && { modified: raw.modified }),
      applied: this.#applied.has(name),
    };
  }
}
