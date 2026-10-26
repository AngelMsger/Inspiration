/** Building and reading event envelopes with typed payloads. */

import { EVENT_PAYLOAD_TYPES, EVENT_TYPES, EVENT_VERSIONS, type EventPayloads, type EventTypeName } from "./events.ts";
import type { EventEnvelope } from "./generated.ts";
import { newId } from "./ids.ts";
import { parseAs } from "./validate.ts";

export interface NewEventOptions {
  tenantId: string;
  /** The component that publishes the event, for example "extraction". */
  producer: string;
  subject?: string;
  correlationId?: string;
  /** The event that caused this one. The new event inherits its correlation ID. */
  causation?: EventEnvelope;
  occurredAt?: Date;
}

export function isEventType(type: string): type is EventTypeName {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/** Wrap a payload in an envelope. The payload is validated against the event's schema. */
export function newEvent<T extends EventTypeName>(
  type: T,
  payload: EventPayloads[T],
  options: NewEventOptions,
): EventEnvelope {
  // A JSON round trip drops undefined fields, so stored and relayed data are identical.
  const data = parseAs<Record<string, unknown>>(EVENT_PAYLOAD_TYPES[type], JSON.parse(JSON.stringify(payload)));
  const { causation } = options;
  const correlationId = options.correlationId ?? (causation ? (causation.correlation_id ?? causation.id) : undefined);
  const event: EventEnvelope = {
    id: newId("event"),
    type,
    version: EVENT_VERSIONS[type],
    tenant_id: options.tenantId,
    occurred_at: (options.occurredAt ?? new Date()).toISOString(),
    producer: options.producer,
    data,
  };
  if (options.subject !== undefined) event.subject = options.subject;
  if (correlationId !== undefined) event.correlation_id = correlationId;
  if (causation) event.causation_id = causation.id;
  return parseAs<EventEnvelope>("EventEnvelope", event);
}

/** An envelope's data as its payload type. Throws TypeError when the event is of another type. */
export function payloadOf<T extends EventTypeName>(event: EventEnvelope, type: T): EventPayloads[T] {
  if (event.type !== type) throw new TypeError(`event ${event.type} is not ${type}`);
  return parseAs<EventPayloads[T]>(EVENT_PAYLOAD_TYPES[type], event.data);
}
