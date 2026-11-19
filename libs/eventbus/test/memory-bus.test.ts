import { EventEmitter } from "node:events";
import { type EventEnvelope, newEvent, newId, payloadOf } from "@inspiration/contracts";
import type pg from "pg";
import { expect, test } from "vitest";
import { Consumer, InMemoryBus, InMemoryTransport, OutboxRelay } from "../src/index.ts";

const TENANT = "ten_01JC0000000000000000000001";

function claimsEvent(): EventEnvelope {
  return newEvent(
    "claims.updated",
    { origin: "extracted", added: [newId("claim")], updated: [], superseded: [] },
    { tenantId: TENANT, producer: "extraction" },
  );
}

test("delivers to each group once", async () => {
  const bus = new InMemoryBus();
  const seen: Record<string, string[]> = { freshness: [], governance: [] };
  bus.subscribe("claims.updated", "freshness", async (e) => void seen.freshness?.push(e.id));
  bus.subscribe("claims.updated", "governance", async (e) => {
    seen.governance?.push(payloadOf(e, "claims.updated").added[0] as string);
  });
  const [e1, e2] = [claimsEvent(), claimsEvent()];
  await bus.publish(e1, e2);
  expect(await bus.drain()).toBe(4);
  expect(seen.freshness).toEqual([e1.id, e2.id]);
  expect(seen.governance).toHaveLength(2);
  expect(await bus.drain()).toBe(0);
});

test("a failing handler is retried, then dead-lettered", async () => {
  const bus = new InMemoryBus({ maxDeliveries: 3 });
  let calls = 0;
  bus.subscribe("claims.updated", "freshness", async () => {
    calls++;
    throw new Error("boom");
  });
  await bus.publish(claimsEvent());
  await bus.drain();
  expect(calls).toBe(3);
  const [dead, ...rest] = bus.deadLetters("freshness");
  expect(rest).toEqual([]);
  expect(dead?.event).toBeDefined();
  expect(dead?.error).toContain("boom");
  expect(bus.transport.pendingCount("freshness")).toBe(0);
});

test("recovers when the handler succeeds on a retry", async () => {
  const bus = new InMemoryBus({ maxDeliveries: 3 });
  let attempts = 0;
  bus.subscribe("claims.updated", "freshness", async () => {
    attempts++;
    if (attempts === 1) throw new Error("transient");
  });
  await bus.publish(claimsEvent());
  await bus.drain();
  expect(attempts).toBe(2);
  expect(bus.deadLetters("freshness")).toEqual([]);
});

test("a newer payload version is dead-lettered", async () => {
  const bus = new InMemoryBus();
  const handled: EventEnvelope[] = [];
  bus.subscribe("claims.updated", "freshness", async (e) => void handled.push(e));
  await bus.publish({ ...claimsEvent(), version: 99 });
  await bus.drain();
  expect(handled).toEqual([]);
  expect(bus.deadLetters("freshness")[0]?.error).toContain("unsupported version");
});

test("an unknown event type is refused", () => {
  const bus = new InMemoryBus();
  expect(() => bus.subscribe("claims.exploded", "freshness", async () => {})).toThrow(RangeError);
});

test("handlers see a copy, not the published object", async () => {
  const bus = new InMemoryBus();
  const event = claimsEvent();
  bus.subscribe("claims.updated", "freshness", async (e) => {
    (e.data.added as string[]).push("changed");
  });
  await bus.publish(event);
  await bus.drain();
  expect(event.data.added).toHaveLength(1);
});

test("Consumer.run() blocks when idle, wakes on send, and exits promptly on stop()", async () => {
  const transport = new InMemoryTransport();
  const consumer = new Consumer(transport, { name: "bg", blockMs: 5_000, visibilityTimeoutMs: 60_000 });
  const seen: string[] = [];
  consumer.subscribe("claims.updated", "freshness", async (e) => void seen.push(e.id));

  const running = consumer.run();
  try {
    const event = claimsEvent();
    await transport.send([event]);
    await expect.poll(() => seen, { timeout: 1_000, interval: 10 }).toEqual([event.id]);
  } finally {
    const stopping = performance.now();
    await consumer.stop();
    await running;
    expect(performance.now() - stopping).toBeLessThan(1_000);
    await transport.close();
  }
});

test("OutboxRelay.run() retries after a transient startup connection failure", async () => {
  const transport = new InMemoryTransport();
  const pending: { seq: number; envelope: EventEnvelope }[] = [{ seq: 1, envelope: claimsEvent() }];
  let connectAttempts = 0;

  const fakeClient = (): pg.Client => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      async query(sql: string) {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes("SELECT seq, envelope")) return { rows: [...pending], rowCount: pending.length };
        if (sql.includes("UPDATE bus.outbox")) {
          pending.length = 0;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    }) as unknown as pg.Client;
  };

  const relay = new OutboxRelay("postgres://unused", transport, {
    retryDelayMs: 20,
    pollIntervalMs: 5_000,
    connect: async () => {
      connectAttempts++;
      if (connectAttempts === 1) throw new Error("ECONNREFUSED");
      return fakeClient();
    },
  });

  const running = relay.run();
  try {
    await expect
      .poll(() => transport.streams.get("claims.updated")?.length ?? 0, { timeout: 2_000, interval: 10 })
      .toBe(1);
    expect(connectAttempts).toBeGreaterThanOrEqual(3);
  } finally {
    await relay.stop();
    await running;
    await transport.close();
  }
});
