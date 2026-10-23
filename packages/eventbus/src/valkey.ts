/**
 * Valkey Streams transport (also works against Redis 6.2+).
 *
 * One stream per event type ("<prefix>:ev:<type>"), one consumer group per component, a
 * dead-letter stream per group ("<prefix>:dlq:<group>"). Streams are trimmed approximately
 * to maxlen entries.
 */

import type { EventEnvelope } from "@inspiration/contracts";
import { Redis } from "ioredis";
import { type Delivery, parseEnvelope, type Transport } from "./transport.ts";

type StreamEntry = [id: string, fields: string[] | null];

function fieldMap(fields: string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; fields && i + 1 < fields.length; i += 2) out[fields[i] as string] = fields[i + 1] as string;
  return out;
}

export interface ValkeyOptions {
  prefix?: string;
  maxlen?: number;
}

export class ValkeyStreamsTransport implements Transport {
  readonly client: Redis;
  readonly prefix: string;
  readonly maxlen: number;

  constructor(client: Redis, options: ValkeyOptions = {}) {
    this.client = client;
    this.prefix = options.prefix ?? "insp";
    this.maxlen = options.maxlen ?? 1_000_000;
  }

  static fromUrl(url: string, options: ValkeyOptions = {}): ValkeyStreamsTransport {
    // RESP2 replies have one fixed shape, which the parsing below relies on.
    return new ValkeyStreamsTransport(new Redis(url, { protocol: 2, lazyConnect: false }), options);
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
    options: { count: number; blockMs: number },
  ): Promise<Delivery[]> {
    const args: (string | number)[] = ["GROUP", group, consumer, "COUNT", options.count];
    // BLOCK 0 means "wait forever" to Valkey, so a zero blockMs must omit BLOCK entirely.
    if (options.blockMs > 0) args.push("BLOCK", options.blockMs);
    args.push("STREAMS", ...eventTypes.map((t) => this.stream(t)), ...eventTypes.map(() => ">"));
    const reply = (await this.client.call("XREADGROUP", args)) as [string, StreamEntry[]][] | null;
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

  async close(): Promise<void> {
    await this.client.quit();
  }
}
