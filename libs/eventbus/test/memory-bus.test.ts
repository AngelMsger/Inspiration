import { type EventEnvelope, newEvent, newId, payloadOf } from "@inspiration/contracts";
import { expect, test } from "vitest";
import { InMemoryBus } from "../src/index.ts";

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
