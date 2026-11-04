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

import { readFile, writeFile } from "node:fs/promises";
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
  await writeFile(file, lines.map((l) => `${l}\n`).join(""));
  return lines.length;
}

/**
 * Puts every reply in file back in the cache for ttlS seconds and returns how many there were.
 * When any line does not parse, or lacks a key or a reply, it writes nothing and names them all.
 */
export async function importReplies(cache: ValkeyCache, file: string, ttlS: number): Promise<number> {
  const entries: { key: string; reply: unknown }[] = [];
  const broken: string[] = [];
  (await readFile(file, "utf8")).split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      broken.push(`line ${i + 1}: not JSON`);
      return;
    }
    const errors = schemaErrors(ENTRY, entry);
    if (errors.length) broken.push(`line ${i + 1}: ${errors.join(", ")}`);
    else entries.push(entry as { key: string; reply: unknown });
  });
  if (broken.length)
    throw new RepliesError(`${file}: nothing imported, ${broken.length} broken lines (${broken.join("; ")})`);
  for (const { key, reply } of entries) await cache.set(key, JSON.stringify(reply), ttlS);
  return entries.length;
}
