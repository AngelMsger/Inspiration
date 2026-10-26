/**
 * In-memory transport and bus, for component tests that should not need Valkey or Postgres.
 *
 * InMemoryTransport has the same semantics as the Valkey transport (per-type streams,
 * consumer groups starting at the oldest event, pending deliveries, reclaim, dead letters),
 * so the real Consumer runs on it unchanged. InMemoryBus wraps both with a deterministic
 * drain() for tests.
 */

import { performance } from "node:perf_hooks";
import type { EventEnvelope, EventHandler } from "@inspiration/contracts";
import { Consumer } from "./consumer.ts";
import type { Delivery, Transport } from "./transport.ts";

interface Pending {
  index: number;
  consumer: string;
  deliveredAt: number;
  attempts: number;
}

interface Group {
  nextIndex: number;
  pending: Map<number, Pending>;
}

export interface DeadLetter {
  readonly event: EventEnvelope | undefined;
  readonly error: string;
}

export class InMemoryTransport implements Transport {
  readonly streams = new Map<string, EventEnvelope[]>();
  readonly #groups = new Map<string, Group>(); // "<type>\0<group>"
  readonly dlq = new Map<string, DeadLetter[]>();

  #group(eventType: string, group: string): Group {
    const g = this.#groups.get(`${eventType}\0${group}`);
    if (!g) throw new RangeError(`no group ${group} on ${eventType}`);
    return g;
  }

  #stream(eventType: string): EventEnvelope[] {
    let s = this.streams.get(eventType);
    if (!s) {
      s = [];
      this.streams.set(eventType, s);
    }
    return s;
  }

  async send(events: readonly EventEnvelope[]): Promise<void> {
    for (const e of events) this.#stream(e.type).push(structuredClone(e));
  }

  async ensureGroup(group: string, eventTypes: readonly string[]): Promise<void> {
    for (const t of eventTypes) {
      this.#stream(t);
      const key = `${t}\0${group}`;
      if (!this.#groups.has(key)) this.#groups.set(key, { nextIndex: 0, pending: new Map() });
    }
  }

  #delivery(eventType: string, index: number, attempt: number): Delivery {
    const event = structuredClone(this.#stream(eventType)[index] as EventEnvelope);
    return { event, stream: eventType, messageId: String(index), attempt, raw: JSON.stringify(event) };
  }

  async receive(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: { count: number; blockMs: number },
  ): Promise<Delivery[]> {
    const out: Delivery[] = [];
    for (const t of eventTypes) {
      const g = this.#group(t, group);
      const stream = this.#stream(t);
      while (g.nextIndex < stream.length && out.length < options.count) {
        const index = g.nextIndex++;
        g.pending.set(index, { index, consumer, deliveredAt: performance.now(), attempts: 1 });
        out.push(this.#delivery(t, index, 1));
      }
    }
    return out;
  }

  async reclaim(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: { minIdleMs: number; count: number },
  ): Promise<Delivery[]> {
    const now = performance.now();
    const out: Delivery[] = [];
    for (const t of eventTypes) {
      const g = this.#group(t, group);
      for (const p of [...g.pending.values()].sort((a, b) => a.index - b.index)) {
        if (out.length >= options.count) break;
        if (now - p.deliveredAt >= options.minIdleMs) {
          p.consumer = consumer;
          p.deliveredAt = now;
          p.attempts += 1;
          out.push(this.#delivery(t, p.index, p.attempts));
        }
      }
    }
    return out;
  }

  async ack(group: string, delivery: Delivery): Promise<void> {
    this.#group(delivery.stream, group).pending.delete(Number(delivery.messageId));
  }

  async deadLetter(group: string, delivery: Delivery, error: string): Promise<void> {
    const list = this.dlq.get(group) ?? [];
    list.push({ event: delivery.event, error });
    this.dlq.set(group, list);
    await this.ack(group, delivery);
  }

  pendingCount(group: string): number {
    let n = 0;
    for (const [key, g] of this.#groups) if (key.endsWith(`\0${group}`)) n += g.pending.size;
    return n;
  }

  async close(): Promise<void> {}
}

/**
 * Publisher and subscriber in one object, for tests.
 *
 *     const bus = new InMemoryBus();
 *     bus.subscribe("claims.updated", "freshness", handler);
 *     await bus.publish(event);
 *     await bus.drain();          // runs handlers until nothing is left
 *
 * Failed handlers are retried immediately, up to maxDeliveries, then dead-lettered.
 */
export class InMemoryBus {
  readonly transport = new InMemoryTransport();
  readonly consumer: Consumer;
  readonly published: EventEnvelope[] = [];

  constructor(options: { maxDeliveries?: number } = {}) {
    this.consumer = new Consumer(this.transport, {
      name: "test",
      maxDeliveries: options.maxDeliveries ?? 3,
      visibilityTimeoutMs: 0,
    });
  }

  subscribe(eventType: string, group: string, handler: EventHandler): void {
    this.consumer.subscribe(eventType, group, handler);
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    this.published.push(...events);
    await this.transport.send(events);
  }

  /** Deliver until every group is idle. Returns the number of handler calls. */
  async drain(maxRounds = 100): Promise<number> {
    let total = 0;
    for (let round = 0; round < maxRounds; round++) {
      let handled = 0;
      for (const group of this.consumer.groups()) handled += await this.consumer.runOnce(group);
      total += handled;
      if (handled === 0) return total;
    }
    throw new Error("InMemoryBus.drain: handlers keep producing events; possible loop");
  }

  deadLetters(group: string): DeadLetter[] {
    return this.transport.dlq.get(group) ?? [];
  }

  ofType(eventType: string): EventEnvelope[] {
    return this.published.filter((e) => e.type === eventType);
  }
}
