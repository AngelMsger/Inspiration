/**
 * Event bus: transactional outbox in Postgres, relay to a transport (Valkey Streams),
 * consumer groups with retries and dead letters, and an in-memory bus for tests. Components
 * that own tables write them through Records, so their rows commit with their events.
 */

export * from "./consumer.ts";
export * from "./inbox.ts";
export * from "./memory.ts";
export * from "./migrations.ts";
export * from "./outbox.ts";
export * from "./records.ts";
export * from "./relay.ts";
export * from "./transport.ts";
export * from "./valkey.ts";
