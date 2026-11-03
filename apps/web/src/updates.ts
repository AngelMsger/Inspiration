/**
 * The demo's upstream edits, for the development backend (backend.ts). Each folder under
 * <corpus>/updates holds new versions of documents at their paths in the corpus, and an
 * update.yaml with a title, the source the documents are in and a question whose answer it
 * changes. Putting one in copies its
 * files over the corpus the engine serves, as someone saving them on the drive would; the
 * backend then syncs that source now, as the person the page acts as. pnpm demo serves a copy
 * of the corpus, so the repository stays as it is.
 *
 *     GET  /api/demo/updates         {"updates": [Update, ...]}
 *     POST /api/demo/updates/:name   SyncReport, once the engine has read the new versions
 */

import { cp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface Update {
  name: string;
  title: string;
  source: string;
  /** A question whose answer the update changes, to ask again once it is in. */
  question?: string;
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
    await cp(join(this.#dir, name), this.#corpus, {
      recursive: true,
      filter: (from) => !from.endsWith(MANIFEST),
    });
    this.#applied.add(name);
    return this.#read(name);
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
      applied: this.#applied.has(name),
    };
  }
}
