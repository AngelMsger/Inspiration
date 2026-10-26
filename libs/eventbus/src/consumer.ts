/**
 * Consumer groups with retries and dead letters, on any Transport.
 *
 * Each component subscribes under its own name as the group ("freshness"). Several
 * processes may run the same group; each event is handled by one of them. Delivery is at
 * least once, so handlers must be idempotent (see firstDelivery for handlers that write to
 * Postgres).
 */

import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENT_VERSIONS, type EventHandler, isEventType } from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import type { Delivery, Transport } from "./transport.ts";

const log = logger("eventbus.consumer");

export interface ConsumerOptions {
  /** This process's name within its groups. Defaults to host and pid. */
  name?: string;
  /** Attempts before an event is dead-lettered. */
  maxDeliveries?: number;
  /** How long a delivery may stay unacked before another consumer takes it over. */
  visibilityTimeoutMs?: number;
  blockMs?: number;
  batchSize?: number;
}

export function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export class Consumer {
  readonly transport: Transport;
  readonly name: string;
  readonly maxDeliveries: number;
  readonly visibilityTimeoutMs: number;
  readonly blockMs: number;
  readonly batchSize: number;
  readonly #handlers = new Map<string, Map<string, EventHandler>>(); // group -> type -> handler
  readonly #ready = new Set<string>();
  #stopping = new AbortController();

  constructor(transport: Transport, options: ConsumerOptions = {}) {
    this.transport = transport;
    this.name = options.name ?? `${hostname()}-${process.pid}`;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
    this.blockMs = options.blockMs ?? 2_000;
    this.batchSize = options.batchSize ?? 32;
  }

  subscribe(eventType: string, group: string, handler: EventHandler): void {
    // An unknown type is a programming error, not something to wait for.
    if (!isEventType(eventType)) throw new RangeError(`unknown event type ${eventType}`);
    let handlers = this.#handlers.get(group);
    if (!handlers) {
      handlers = new Map();
      this.#handlers.set(group, handlers);
    }
    if (handlers.has(eventType)) throw new RangeError(`${group} already handles ${eventType}`);
    handlers.set(eventType, handler);
    this.#ready.delete(group);
  }

  groups(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  async #ensure(group: string): Promise<string[]> {
    const types = [...(this.#handlers.get(group)?.keys() ?? [])].sort();
    if (!this.#ready.has(group)) {
      await this.transport.ensureGroup(group, types);
      this.#ready.add(group);
    }
    return types;
  }

  async #handle(group: string, d: Delivery): Promise<void> {
    if (d.event === undefined) {
      await this.transport.deadLetter(group, d, "unparseable envelope");
      return;
    }
    const known = isEventType(d.event.type) ? EVENT_VERSIONS[d.event.type] : undefined;
    if (known === undefined || d.event.version > known) {
      await this.transport.deadLetter(group, d, `unsupported version ${d.event.version} of ${d.event.type}`);
      return;
    }
    const handler = this.#handlers.get(group)?.get(d.event.type);
    if (!handler) {
      await this.transport.deadLetter(group, d, `${group} has no handler for ${d.event.type}`);
      return;
    }
    try {
      await handler(d.event);
    } catch (e) {
      // A failing handler must not stop the loop. The delivery stays pending and is
      // reclaimed after the visibility timeout.
      const fields = { group, event: d.event.id, attempt: d.attempt, error: e };
      if (d.attempt >= this.maxDeliveries) {
        log.error("dead-lettering after the last attempt", fields);
        await this.transport.deadLetter(group, d, describeError(e));
      } else {
        log.warn("handler failed", fields);
      }
      return;
    }
    await this.transport.ack(group, d);
  }

  /** Handle what is available now (reclaimed first, then new). Returns deliveries handled. */
  async runOnce(group: string, options: { blockMs?: number } = {}): Promise<number> {
    const types = await this.#ensure(group);
    const deliveries = await this.transport.reclaim(group, this.name, types, {
      minIdleMs: this.visibilityTimeoutMs,
      count: this.batchSize,
    });
    deliveries.push(
      ...(await this.transport.receive(group, this.name, types, {
        count: this.batchSize,
        blockMs: options.blockMs ?? 0,
      })),
    );
    for (const d of deliveries) await this.#handle(group, d);
    return deliveries.length;
  }

  async #loop(group: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(group, { blockMs: this.blockMs });
      } catch (error) {
        log.error("consumer loop failed; retrying", { group, error });
        await sleep(1000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  /** Run every group until stop() is called. */
  async run(): Promise<void> {
    this.#stopping = new AbortController();
    const { signal } = this.#stopping;
    await Promise.all(this.groups().map((g) => this.#loop(g, signal)));
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
  }
}
