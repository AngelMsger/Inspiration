/**
 * Valkey Streams transport (also works against Redis 6.2+).
 *
 * One stream per event type ("<prefix>:ev:<type>"), one consumer group per component, a
 * dead-letter stream per group ("<prefix>:dlq:<group>"). Streams are trimmed approximately
 * to maxlen entries.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { EventEnvelope } from "@inspiration/contracts";
import { Redis } from "ioredis";
import { type Delivery, parseEnvelope, type ReceiveOptions, type Transport } from "./transport.ts";

type StreamEntry = [id: string, fields: string[] | null];

function fieldMap(fields: string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; fields && i + 1 < fields.length; i += 2) out[fields[i] as string] = fields[i + 1] as string;
  return out;
}

// Reserve work for a group atomically, so a peer cannot start the next batch before this
// one is acknowledged. On takeover, retry the oldest pending entry of a stream first.
const READ_ORDERED = `
local group, consumer, retry = ARGV[1], ARGV[2], tonumber(ARGV[3])
for _, stream in ipairs(KEYS) do
  local head = redis.call('XPENDING', stream, group, '-', '+', 1)[1]
  if head then
    if head[3] >= retry then
      local entry = redis.call('XCLAIM', stream, group, consumer, retry, head[1])[1]
      if entry then return {{{stream, entry, head[4] + 1}}, {}} end
    end
    return {{}, {}}
  end
end
local args = {'GROUP', group, consumer, 'COUNT', 1, 'STREAMS', unpack(KEYS)}
for _ = 1, #KEYS do table.insert(args, '>') end
local read = redis.call('XREADGROUP', unpack(args))
local deliveries, positions = {}, {}
if read then
  for _, result in ipairs(read) do table.insert(deliveries, {result[1], result[2][1], 1}) end
else
  -- Capture the positions before releasing the script, so a blocking wake-up cannot miss XADD.
  for _, stream in ipairs(KEYS) do
    local tail = redis.call('XREVRANGE', stream, '+', '-', 'COUNT', 1)[1]
    table.insert(positions, tail and tail[1] or '0-0')
  end
end
return {deliveries, positions}`;

type OrderedReader = Redis & {
  inspirationReadOrdered(
    keyCount: number,
    ...args: (string | number)[]
  ): Promise<[[string, StreamEntry, number][], string[]]>;
};

export interface ValkeyOptions {
  prefix?: string;
  maxlen?: number;
}

export class ValkeyStreamsTransport implements Transport {
  readonly client: Redis;
  readonly prefix: string;
  readonly maxlen: number;
  readonly #readers = new Map<string, Redis>();

  constructor(client: Redis, options: ValkeyOptions = {}) {
    client.defineCommand("inspirationReadOrdered", { lua: READ_ORDERED });
    this.client = client;
    this.prefix = options.prefix ?? "insp";
    this.maxlen = options.maxlen ?? 1_000_000;
  }

  static fromUrl(url: string, options: ValkeyOptions = {}): ValkeyStreamsTransport {
    // RESP2 replies have one fixed shape, which the parsing below relies on.
    return new ValkeyStreamsTransport(new Redis(url, { protocol: 2, lazyConnect: false }), options);
  }

  #reader(group: string): Redis {
    let client = this.#readers.get(group);
    if (!client) {
      client = this.client.duplicate();
      this.#readers.set(group, client);
    }
    return client;
  }

  stream(eventType: string): string {
    return `${this.prefix}:ev:${eventType}`;
  }

  dlq(group: string): string {
    return `${this.prefix}:dlq:${group}`;
  }

  async send(events: readonly EventEnvelope[]): Promise<void> {
    if (!events.length) return;
    const pipe = this.client.pipeline();
    for (const e of events) {
      pipe.call("XADD", [this.stream(e.type), "MAXLEN", "~", this.maxlen, "*", "e", JSON.stringify(e)]);
    }
    for (const [error] of (await pipe.exec()) ?? []) if (error) throw error;
  }

  async ensureGroup(group: string, eventTypes: readonly string[]): Promise<void> {
    for (const t of eventTypes) {
      try {
        await this.client.call("XGROUP", ["CREATE", this.stream(t), group, "0", "MKSTREAM"]);
      } catch (e) {
        if (!String((e as Error).message).includes("BUSYGROUP")) throw e;
      }
    }
  }

  #delivery(stream: string, [messageId, fields]: StreamEntry, attempt: number): Delivery {
    const raw = fieldMap(fields).e;
    const d: Delivery = { event: parseEnvelope(raw), stream, messageId, attempt };
    return raw === undefined ? d : { ...d, raw };
  }

  async receive(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: ReceiveOptions,
  ): Promise<Delivery[]> {
    if (options.orderedRetryMs !== undefined) {
      const streams = eventTypes.map((t) => this.stream(t));
      const [entries, positions] = await (this.client as OrderedReader).inspirationReadOrdered(
        streams.length,
        ...streams,
        group,
        consumer,
        options.orderedRetryMs,
      );
      if (entries.length) return entries.map(([stream, entry, attempt]) => this.#delivery(stream, entry, attempt));
      if (options.blockMs > 0 && !options.signal?.aborted) {
        if (positions.length) {
          const wake = await this.#reader(group).call("XREAD", [
            "BLOCK",
            options.blockMs,
            "COUNT",
            1,
            "STREAMS",
            ...streams,
            ...positions,
          ]);
          if (wake && !options.signal?.aborted)
            return this.receive(group, consumer, eventTypes, { ...options, blockMs: 0 });
        } else {
          // A peer's ACK can free the group without appending to a stream.
          await sleep(Math.min(options.blockMs, 100), undefined, { signal: options.signal }).catch(() => undefined);
        }
      }
      return [];
    }
    const args: (string | number)[] = ["GROUP", group, consumer, "COUNT", options.count];
    // BLOCK 0 means "wait forever" to Valkey, so a zero blockMs must omit BLOCK entirely.
    if (options.blockMs > 0) args.push("BLOCK", options.blockMs);
    args.push("STREAMS", ...eventTypes.map((t) => this.stream(t)), ...eventTypes.map(() => ">"));
    // Blocking XREADGROUP stalls its TCP connection, so each group gets its own reader client.
    const client = options.blockMs > 0 ? this.#reader(group) : this.client;
    const reply = (await client.call("XREADGROUP", args)) as [string, StreamEntry[]][] | null;
    const out: Delivery[] = [];
    for (const [stream, messages] of reply ?? []) for (const m of messages) out.push(this.#delivery(stream, m, 1));
    return out;
  }

  async reclaim(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: { minIdleMs: number; count: number },
  ): Promise<Delivery[]> {
    const out: Delivery[] = [];
    for (const t of eventTypes) {
      const stream = this.stream(t);
      const reply = (await this.client.call("XAUTOCLAIM", [
        stream,
        group,
        consumer,
        options.minIdleMs,
        "0-0",
        "COUNT",
        options.count,
      ])) as [string, StreamEntry[], ...unknown[]];
      for (const entry of reply[1]) {
        // XAUTOCLAIM has already counted this delivery.
        const pending = (await this.client.call("XPENDING", [stream, group, entry[0], entry[0], 1])) as [
          string,
          string,
          number,
          number,
        ][];
        out.push(this.#delivery(stream, entry, pending[0] ? Number(pending[0][3]) : 1));
      }
    }
    return out;
  }

  async ack(group: string, delivery: Delivery): Promise<void> {
    await this.client.call("XACK", [delivery.stream, group, delivery.messageId]);
  }

  async deadLetter(group: string, delivery: Delivery, error: string): Promise<void> {
    await this.client.call("XADD", [
      this.dlq(group),
      "MAXLEN",
      "~",
      this.maxlen,
      "*",
      "e",
      delivery.raw ?? "",
      "stream",
      delivery.stream,
      "message_id",
      delivery.messageId,
      "attempt",
      String(delivery.attempt),
      "error",
      error.slice(0, 2000),
    ]);
    await this.ack(group, delivery);
  }

  /** A group's dead-letter stream, for operations and tests. */
  async deadLetters(group: string, count = 100): Promise<Record<string, string>[]> {
    const rows = (await this.client.call("XRANGE", [this.dlq(group), "-", "+", "COUNT", count])) as StreamEntry[];
    return rows.map(([id, fields]) => ({ ...fieldMap(fields), id }));
  }

  async isIdle(group: string, eventTypes: readonly string[]): Promise<boolean> {
    for (const t of eventTypes) {
      const stream = this.stream(t);
      let rawGroups: unknown[][];
      try {
        rawGroups = (await this.client.call("XINFO", ["GROUPS", stream])) as unknown[][];
      } catch (e) {
        if (String((e as Error).message).includes("no such key")) continue;
        throw e;
      }
      const entry = rawGroups.find((row) => {
        for (let i = 0; i + 1 < row.length; i += 2) if (row[i] === "name") return row[i + 1] === group;
        return false;
      });
      if (!entry) {
        if (Number(await this.client.call("XLEN", [stream])) > 0) return false;
        continue;
      }
      const info: Record<string, unknown> = {};
      for (let i = 0; i + 1 < entry.length; i += 2) info[String(entry[i])] = entry[i + 1];
      if (Number(info.pending ?? 0) > 0) return false;
      if (info.lag !== null && info.lag !== undefined) {
        if (Number(info.lag) > 0) return false;
        continue;
      }
      // Valkey reports lag as null before the first read or after trimming; compare IDs directly.
      const latest = (await this.client.call("XREVRANGE", [stream, "+", "-", "COUNT", 1])) as StreamEntry[];
      if (latest[0] && latest[0][0] !== String(info["last-delivered-id"] ?? "0-0")) return false;
    }
    return true;
  }

  async close(): Promise<void> {
    const clients = [this.client, ...this.#readers.values()];
    this.#readers.clear();
    await Promise.allSettled(clients.map((c) => c.quit()));
  }
}
