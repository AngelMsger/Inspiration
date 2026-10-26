// Outbox, relay and Valkey Streams consumers against the real stack.

import { type EventEnvelope, newEvent, newId } from "@inspiration/contracts";
import { connect } from "@inspiration/kernel";
import { hasStack, stackTest as test } from "@inspiration/testkit";
import { describe, expect } from "vitest";
import { Consumer, firstDelivery, OutboxRelay, ValkeyStreamsTransport, writeOutbox } from "../src/index.ts";

const TENANT = "ten_01JC0000000000000000000001";

function claimsEvent(): EventEnvelope {
  return newEvent(
    "claims.updated",
    { origin: "extracted", added: [newId("claim")], updated: [], superseded: [] },
    { tenantId: TENANT, producer: "extraction" },
  );
}

async function pendingRows(url: string): Promise<number> {
  const client = await connect(url);
  try {
    const { rows } = await client.query<{ n: number }>("SELECT count(*) AS n FROM bus.outbox WHERE relayed_at IS NULL");
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasStack())("outbox and Valkey Streams", () => {
  test("outbox rows commit with the transaction", async ({ databaseUrl }) => {
    const client = await connect(databaseUrl);
    try {
      await client.query("BEGIN");
      await writeOutbox(client, [claimsEvent()]);
      await client.query("COMMIT");
      await client.query("BEGIN");
      await writeOutbox(client, [claimsEvent()]);
      await client.query("ROLLBACK");
      // A repeated event ID is ignored.
      const e = claimsEvent();
      await writeOutbox(client, [e, e]);
    } finally {
      await client.end();
    }
    expect(await pendingRows(databaseUrl)).toBe(2);
  });

  test("relay to consumer, end to end", async ({ databaseUrl, valkey, streamPrefix }) => {
    const transport = new ValkeyStreamsTransport(valkey, { prefix: streamPrefix });
    const consumer = new Consumer(transport, { name: "c1", blockMs: 50 });
    const received: string[] = [];
    consumer.subscribe("claims.updated", "freshness", async (e) => void received.push(e.id));
    // The group is created before anything is published; it must still start at the oldest event.
    await consumer.runOnce("freshness");

    const events = [claimsEvent(), claimsEvent(), claimsEvent()];
    const client = await connect(databaseUrl);
    try {
      await writeOutbox(client, events);
      const relay = new OutboxRelay(databaseUrl, transport, { batchSize: 2 });
      expect(await relay.drain(client)).toBe(3);
      expect(await relay.drain(client)).toBe(0);
    } finally {
      await client.end();
    }
    expect(await pendingRows(databaseUrl)).toBe(0);

    await consumer.runOnce("freshness");
    expect(received).toEqual(events.map((e) => e.id));
    expect(await consumer.runOnce("freshness")).toBe(0);
  });

  test("a failed delivery is reclaimed, then dead-lettered", async ({ valkey, streamPrefix }) => {
    const transport = new ValkeyStreamsTransport(valkey, { prefix: streamPrefix });
    const consumer = new Consumer(transport, { name: "c1", maxDeliveries: 2, visibilityTimeoutMs: 0, blockMs: 10 });
    let attempts = 0;
    consumer.subscribe("claims.updated", "governance", async () => {
      attempts++;
      throw new TypeError("cannot handle");
    });
    await consumer.runOnce("governance");
    await transport.send([claimsEvent()]);
    await consumer.runOnce("governance"); // attempt 1, stays pending
    await consumer.runOnce("governance"); // reclaimed: attempt 2, dead-lettered
    expect(attempts).toBe(2);
    const dead = await transport.deadLetters("governance");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.error).toBe("TypeError: cannot handle");
    expect(dead[0]?.attempt).toBe("2");
    expect(await consumer.runOnce("governance")).toBe(0);
  });

  test("a poison message is dead-lettered without calling the handler", async ({ valkey, streamPrefix }) => {
    const transport = new ValkeyStreamsTransport(valkey, { prefix: streamPrefix });
    const consumer = new Consumer(transport, { name: "c1" });
    let calls = 0;
    consumer.subscribe("claims.updated", "governance", async () => void calls++);
    await consumer.runOnce("governance");
    await valkey.call("XADD", [transport.stream("claims.updated"), "*", "e", "{not json"]);
    await consumer.runOnce("governance");
    expect(calls).toBe(0);
    const dead = await transport.deadLetters("governance");
    expect(dead.map((d) => [d.error, d.e])).toEqual([["unparseable envelope", "{not json"]]);
  });

  test("the relay runs and wakes on NOTIFY", async ({ databaseUrl, valkey, streamPrefix }) => {
    const transport = new ValkeyStreamsTransport(valkey, { prefix: streamPrefix });
    const relay = new OutboxRelay(databaseUrl, transport, { pollIntervalMs: 30_000 }); // only NOTIFY can wake it in time
    const running = relay.run();
    try {
      await new Promise((r) => setTimeout(r, 500));
      const client = await connect(databaseUrl);
      await writeOutbox(client, [claimsEvent()]);
      await client.end();
      const stream = transport.stream("claims.updated");
      await expect.poll(() => valkey.xlen(stream), { timeout: 5_000, interval: 100 }).toBe(1);
    } finally {
      await relay.stop();
      await running;
    }
  });

  test("the inbox dedupes redeliveries", async ({ databaseUrl }) => {
    const client = await connect(databaseUrl);
    try {
      const id = "evt_01JC0000000000000000000001";
      expect(await firstDelivery(client, "freshness", id)).toBe(true);
      expect(await firstDelivery(client, "freshness", id)).toBe(false);
      expect(await firstDelivery(client, "governance", id)).toBe(true);
    } finally {
      await client.end();
    }
  });
});
