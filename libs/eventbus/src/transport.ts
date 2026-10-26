/**
 * The delivery layer under the bus. Valkey Streams in the prototype; NATS JetStream or
 * Kafka later, behind the same interface, without changes to component code.
 */

import { contractErrors, type EventEnvelope } from "@inspiration/contracts";

/** One delivery of one event to one consumer group. */
export interface Delivery {
  /** Undefined when the message could not be parsed as an envelope. */
  readonly event: EventEnvelope | undefined;
  readonly stream: string;
  readonly messageId: string;
  /** 1 on first delivery. */
  readonly attempt: number;
  /** The unparsed payload, kept for dead-lettering poison messages. */
  readonly raw?: string;
}

export interface Transport {
  /** Append events to their streams. Must be safe to repeat (consumers dedupe on event id). */
  send(events: readonly EventEnvelope[]): Promise<void>;
  /** Create the group on each event type's stream, starting from the oldest retained event. */
  ensureGroup(group: string, eventTypes: readonly string[]): Promise<void>;
  /** New events for the group. Returned deliveries stay pending until acked. */
  receive(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: { count: number; blockMs: number },
  ): Promise<Delivery[]>;
  /** Take over deliveries pending longer than minIdleMs (failed handlers, dead consumers). */
  reclaim(
    group: string,
    consumer: string,
    eventTypes: readonly string[],
    options: { minIdleMs: number; count: number },
  ): Promise<Delivery[]>;
  ack(group: string, delivery: Delivery): Promise<void>;
  /** Move a delivery to the group's dead-letter stream and ack it. */
  deadLetter(group: string, delivery: Delivery, error: string): Promise<void>;
  close(): Promise<void>;
}

/** The envelope in a raw message, or undefined when it is not a valid one. */
export function parseEnvelope(raw: string | undefined): EventEnvelope | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return contractErrors("EventEnvelope", value).length ? undefined : (value as EventEnvelope);
  } catch {
    return undefined;
  }
}
