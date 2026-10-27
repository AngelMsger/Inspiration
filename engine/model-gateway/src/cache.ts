/** Exact-match response cache for deterministic completions (temperature 0 or unset). */

import { Redis } from "ioredis";

export interface ResponseCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlS: number): Promise<void>;
}

/** Least recently used, in process. TTLs are ignored: entries live until evicted. */
export class MemoryCache implements ResponseCache {
  readonly maxEntries: number;
  readonly #data = new Map<string, string>();

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<string | undefined> {
    const value = this.#data.get(key);
    if (value !== undefined) {
      this.#data.delete(key);
      this.#data.set(key, value);
    }
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    this.#data.delete(key);
    this.#data.set(key, value);
    while (this.#data.size > this.maxEntries) this.#data.delete(this.#data.keys().next().value as string);
  }
}

/** Shared by every gateway process, at "<prefix>:gw:cache:<key>". */
export class ValkeyCache implements ResponseCache {
  readonly client: Redis;
  readonly prefix: string;

  constructor(client: Redis, options: { prefix?: string } = {}) {
    this.client = client;
    this.prefix = `${options.prefix ?? "insp"}:gw:cache:`;
  }

  /** A cache with a client of its own, for a process that has none; close() ends it. */
  static fromUrl(url: string, options: { prefix?: string } = {}): ValkeyCache {
    return new ValkeyCache(new Redis(url), options);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(this.prefix + key)) ?? undefined;
  }

  async set(key: string, value: string, ttlS: number): Promise<void> {
    await this.client.set(this.prefix + key, value, "EX", ttlS);
  }

  /** Every entry, keys without the prefix: for keeping the replies longer than the store lives. */
  async *entries(): AsyncGenerator<[key: string, value: string]> {
    const seen = new Set<string>(); // SCAN may return a key twice
    let cursor = "0";
    do {
      const [next, keys] = await this.client.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 500);
      cursor = next;
      const fresh = keys.filter((k) => !seen.has(k));
      if (!fresh.length) continue;
      const values = await this.client.mget(fresh);
      for (const [i, k] of fresh.entries()) {
        seen.add(k);
        const value = values[i];
        if (value != null) yield [k.slice(this.prefix.length), value];
      }
    } while (cursor !== "0");
  }
}
