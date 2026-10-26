/** Exact-match response cache for deterministic completions (temperature 0 or unset). */

import type { Redis } from "ioredis";

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

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(this.prefix + key)) ?? undefined;
  }

  async set(key: string, value: string, ttlS: number): Promise<void> {
    await this.client.set(this.prefix + key, value, "EX", ttlS);
  }
}
