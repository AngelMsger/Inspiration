/**
 * Model replies kept longer than a container: the gateway's Valkey response cache written to
 * a JSON lines file and read back, so a later run reuses every reply an earlier one paid for
 * and pays only for the calls a change makes new (apps/bench/runs/README.md). Each line is one
 * cache entry: its key, which hashes the model, task, prompt version and messages, and the
 * reply as the gateway cached it, readable for an audit.
 *
 * The file is a backup of replies this project's gateway produced, and nothing more. Nothing
 * checks a reply against the provider, and whoever edits the file can plant replies, so it is
 * imported only into a bench cache, never into a shared or production one. Since it is the
 * only copy of paid replies once the container is gone, an import checks every line first
 * and writes nothing when one is broken.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { schemaErrors } from "@inspiration/contracts";
import type { ValkeyCache } from "@inspiration/model-gateway";

export class RepliesError extends Error {
  override name = "RepliesError";
}

const ENTRY = { type: "object", required: ["key", "reply"], properties: { key: { type: "string", minLength: 1 } } };

/** Writes every cached reply to file and returns how many there were. */
export async function exportReplies(cache: ValkeyCache, file: string): Promise<number> {
  const lines: string[] = [];
  for await (const [key, value] of cache.entries()) lines.push(JSON.stringify({ key, reply: JSON.parse(value) }));
  lines.sort(); // the same replies make the same file
  // Line by line: the decisive test's 1.2 GB of replies is past the longest string V8 allows.
  // The lines are still held to sort them, so memory grows with the cache.
  const out = createWriteStream(file);
  for (const line of lines) if (!out.write(`${line}\n`)) await once(out, "drain");
  out.end();
  await finished(out);
  return lines.length;
}

/**
 * Puts every reply in file back in the cache for ttlS seconds and returns how many there were.
 * When any line does not parse, or lacks a key or a reply, it writes nothing and names them all.
 * The file is checked in a first pass and written in a second, so the decisive test's 1.2 GB of
 * replies, past the longest string V8 allows, is never held at once; it must not change between
 * the passes.
 */
export async function importReplies(cache: ValkeyCache, file: string, ttlS: number): Promise<number> {
  const broken: string[] = [];
  for await (const [n, line] of linesOf(file)) {
    const entry = entryOf(line);
    if (typeof entry === "string") broken.push(`line ${n}: ${entry}`);
  }
  if (broken.length)
    throw new RepliesError(`${file}: nothing imported, ${broken.length} broken lines (${broken.join("; ")})`);
  let count = 0;
  for await (const [, line] of linesOf(file)) {
    const { key, reply } = entryOf(line) as { key: string; reply: unknown };
    await cache.set(key, JSON.stringify(reply), ttlS);
    count++;
  }
  return count;
}

/** The file's non-empty lines with their numbers, read as a stream. */
async function* linesOf(file: string): AsyncGenerator<[number, string]> {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })) {
    n++;
    if (line.trim()) yield [n, line];
  }
}

/** A line's entry, or what is wrong with it. */
function entryOf(line: string): { key: string; reply: unknown } | string {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return "not JSON";
  }
  const errors = schemaErrors(ENTRY, entry);
  return errors.length ? errors.join(", ") : (entry as { key: string; reply: unknown });
}
