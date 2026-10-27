/**
 * Model replies kept longer than a container: the gateway's Valkey response cache written to
 * a JSON lines file and read back, so a later run reuses every reply an earlier one paid for
 * and pays only for the calls a change makes new (apps/bench/runs/README.md). Each line is one
 * cache entry: its key, which hashes the model, task, prompt version and messages, and the
 * reply as the gateway cached it, readable for an audit.
 */

import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ValkeyCache } from "@inspiration/model-gateway";

/** Writes every cached reply to file and returns how many there were. */
export async function exportReplies(cache: ValkeyCache, file: string): Promise<number> {
  const lines: string[] = [];
  for await (const [key, value] of cache.entries()) lines.push(JSON.stringify({ key, reply: JSON.parse(value) }));
  lines.sort(); // the same replies make the same file
  await writeFile(file, lines.map((l) => `${l}\n`).join(""));
  return lines.length;
}

/** Puts every reply in file back in the cache for ttlS seconds and returns how many there were. */
export async function importReplies(cache: ValkeyCache, file: string, ttlS: number): Promise<number> {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!line.trim()) continue;
    const { key, reply } = JSON.parse(line) as { key: string; reply: unknown };
    await cache.set(key, JSON.stringify(reply), ttlS);
    n++;
  }
  return n;
}
