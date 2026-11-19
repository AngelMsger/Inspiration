// Batch vs multi-replica service event delivery modes on Engine.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEvent, newId, type Principal } from "@inspiration/contracts";
import { RELAY_LOCK, writeOutbox } from "@inspiration/eventbus";
import { connect } from "@inspiration/kernel";
import { Sample } from "@inspiration/knowledge-store/testing";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Engine, SERVER_VISIBILITY_TIMEOUT_MS } from "../src/index.ts";
import { resolveTodo } from "../src/todos.ts";

const TENANT = "ten_01JC0000000000000000000001";

function claimsEvent() {
  return newEvent(
    "claims.updated",
    { origin: "extracted", added: [newId("claim")], updated: [], superseded: [] },
    { tenantId: TENANT, producer: "extraction" },
  );
}

const dirs: string[] = [];

async function tempBlobs(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-delivery-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("default batch mode uses immediate retries, synchronous settle(), and refuses startDelivery()", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs() });
  try {
    expect(engine.deliveryMode).toBe("batch");
    expect(engine.consumer.visibilityTimeoutMs).toBe(0);
    expect(engine.consumer.name).toBe("engine");
    expect(() => engine.startDelivery()).toThrow(/deliveryMode: "service"/);

    let attempts = 0;
    engine.observe("claims.updated", "batch-observer", async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient failure");
    });

    await engine.transport.send([claimsEvent()]);
    const delivered = await engine.settle();
    expect(delivered).toBeGreaterThanOrEqual(2);
    expect(attempts).toBe(2);
  } finally {
    await engine.close();
  }
});

test("service mode uses a non-zero visibility timeout and per-process consumer name", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  try {
    expect(engine.deliveryMode).toBe("service");
    expect(engine.consumer.visibilityTimeoutMs).toBe(SERVER_VISIBILITY_TIMEOUT_MS);
    expect(engine.consumer.visibilityTimeoutMs).toBeGreaterThan(0);
    expect(engine.consumer.name).not.toBe("engine");
    expect(engine.consumer.name).toContain(`-${process.pid}`);

    // Before startDelivery(), settle() still drains synchronously (e.g. during corpus seeding).
    const seen: string[] = [];
    engine.observe("claims.updated", "pre-start-observer", async (e) => void seen.push(e.id));
    const event = claimsEvent();
    await engine.transport.send([event]);
    await engine.settle();
    expect(seen).toEqual([event.id]);
  } finally {
    await engine.close();
  }
});

test("service mode startDelivery() delivers in the background, guards settle/settleLater, and closes cleanly", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  const seen: string[] = [];
  engine.observe("claims.updated", "service-observer", async (e) => void seen.push(e.id));

  const runSpy = vi.spyOn(engine.consumer, "run");
  const stopSpy = vi.spyOn(engine.consumer, "stop");
  const runOnceSpy = vi.spyOn(engine.consumer, "runOnce");

  engine.startDelivery();
  // Calling startDelivery() again is a no-op.
  engine.startDelivery();
  expect(runSpy).toHaveBeenCalledTimes(1);

  // Late subscriptions are refused once background consumer loops have snapshotted groups.
  expect(() => engine.observe("claims.updated", "late-observer", async () => {})).toThrow(/delivery has started/);

  const event = claimsEvent();
  await engine.transport.send([event]);
  await expect.poll(() => seen, { timeout: 2_000, interval: 20 }).toEqual([event.id]);

  // settle() and settleLater() must not bypass background delivery or invoke runOnce directly.
  expect(await engine.settle()).toBe(0);
  engine.settleLater();
  await new Promise((r) => setTimeout(r, 20));
  // Consumer.#loop always passes { blockMs, signal }; direct #deliver() calls omit options.
  expect(runOnceSpy.mock.calls.filter((args) => args.length === 1)).toEqual([]);

  // close() stops the background consumer promptly without leaking timers or pending loops.
  const startedClose = performance.now();
  await engine.close();
  expect(stopSpy).toHaveBeenCalledTimes(1);
  expect(performance.now() - startedClose).toBeLessThan(1_000);
});

test("service mode does not immediately reclaim an in-flight failed delivery", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  let attempts = 0;
  engine.observe("claims.updated", "slow-observer", async () => {
    attempts++;
    throw new Error("still failing");
  });

  engine.startDelivery();
  try {
    await engine.transport.send([claimsEvent()]);
    await expect.poll(() => attempts, { timeout: 2_000, interval: 20 }).toBe(1);
    // Wait briefly and verify visibilityTimeoutMs prevents immediate redelivery/stealing.
    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1);
  } finally {
    await engine.close();
  }
});

test("service mode settle() waits for conflict resolution so the next read sees the winning claim", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  const kb = new Sample({ tenantId: TENANT });
  const ownerId = newId("member");
  const owner: Principal = { kind: "member", id: ownerId, tenant_id: TENANT };
  const [sv1, [span1]] = kb.sourceVersion(["Hotel cap is 600 yuan a night."]);
  const [sv2, [span2]] = kb.sourceVersion(["Hotel cap is 800 yuan a night."]);
  const [c1, e1] = kb.claim("Hotel cap is 600 yuan a night.", span1, {
    predicate: "hotel_cap",
    slot_key: "hotel_cap",
    value: { kind: "money", number: 600, unit: "CNY/night", currency: "CNY", normalized: "600 CNY/night" },
  });
  const [c2, e2] = kb.claim("Hotel cap is 800 yuan a night.", span2, {
    predicate: "hotel_cap",
    slot_key: "hotel_cap",
    value: { kind: "money", number: 800, unit: "CNY/night", currency: "CNY", normalized: "800 CNY/night" },
  });

  engine.startDelivery();
  try {
    await engine.directory.putTenant(
      TENANT,
      { name: "Test", kind: "team", default_locale: "en", version: 1 },
      "svc_01TEST000000000000000000",
    );
    await engine.directory.putMember(TENANT, ownerId, {
      display_name: "Owner",
      status: "active",
      roles: ["member"],
      version: 1,
    });
    await engine.directory.createSpace(TENANT, { name: "Travel", owner_ids: [ownerId] }, { spaceId: kb.spaceId });
    await engine.store.transaction(async (tx) => {
      await tx.putSourceVersion(sv1, [span1]);
      await tx.putSourceVersion(sv2, [span2]);
      await tx.upsertClaims([c1, c2], [...e1, ...e2]);
      await tx.publish(
        newEvent(
          "claims.updated",
          { origin: "extracted", added: [c1.id, c2.id], updated: [], superseded: [] },
          { tenantId: TENANT, producer: "extraction" },
        ),
      );
    });
    await engine.settle();

    // Immediately after settle(), governance has opened the conflict todo and collaboration has stored it.
    const conflict = (await engine.inbox.items(TENANT)).find(
      (i) => i.todo.status === "open" && i.todo.slot_key === "hotel_cap",
    );
    const chosen = conflict?.todo.resolutions?.[0]?.key;
    if (!conflict || !chosen) throw new Error("expected an open conflict todo with resolutions");

    expect((await engine.governance.verdicts(TENANT, ["hotel_cap"]))[0]?.disputed).toBe(true);
    expect(await engine.governance.conflicts(TENANT, "open")).toHaveLength(1);

    // resolveTodo() calls engine.settle(); the very next read must already reflect the chosen value.
    const result = await resolveTodo(engine, owner, conflict.todo.id, { with: chosen });
    expect(result.todo?.status).toBe("done");
    expect((await engine.governance.verdicts(TENANT, ["hotel_cap"]))[0]?.disputed).toBe(false);
    expect(await engine.governance.conflicts(TENANT, "open")).toEqual([]);
  } finally {
    await engine.close();
  }
});

describe.skipIf(!hasStack())("service mode on Postgres and Valkey", () => {
  stackTest(
    "holds RELAY_LOCK, relays and delivers via background workers, and releases on close()",
    async ({ databaseUrl, streamPrefix, valkey: _valkey }) => {
      const engine = await Engine.open({
        blobDir: await tempBlobs(),
        databaseUrl,
        valkeyUrl: VALKEY_URL,
        streamPrefix,
        deliveryMode: "service",
      });
      const seen: string[] = [];
      engine.observe("claims.updated", "stack-observer", async (e) => void seen.push(e.id));

      engine.startDelivery();
      const probe = await connect(databaseUrl);
      try {
        // Wait for OutboxRelay.run() to acquire RELAY_LOCK.
        await expect
          .poll(
            async () => {
              const { rows } = await probe.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
                RELAY_LOCK,
              ]);
              if (rows[0]?.locked) await probe.query("SELECT pg_advisory_unlock($1)", [RELAY_LOCK]);
              return rows[0]?.locked;
            },
            { timeout: 5_000, interval: 50 },
          )
          .toBe(false);

        const event = claimsEvent();
        await writeOutbox(probe, [event]);
        await expect.poll(() => seen, { timeout: 5_000, interval: 50 }).toEqual([event.id]);
      } finally {
        await engine.close();
        // Closing the engine stops OutboxRelay.run() and releases RELAY_LOCK.
        const { rows } = await probe.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
          RELAY_LOCK,
        ]);
        expect(rows[0]?.locked).toBe(true);
        await probe.end();
      }
    },
  );

  stackTest(
    "a second persistent replica settles through the first replica's RELAY_LOCK without bypassing it",
    async ({ databaseUrl, streamPrefix, valkey: _valkey }) => {
      const primary = await Engine.open({
        blobDir: await tempBlobs(),
        databaseUrl,
        valkeyUrl: VALKEY_URL,
        streamPrefix,
        deliveryMode: "service",
      });
      const secondary = await Engine.open({
        blobDir: await tempBlobs(),
        databaseUrl,
        valkeyUrl: VALKEY_URL,
        streamPrefix,
        deliveryMode: "service",
      });
      const seen: string[] = [];
      primary.observe("claims.updated", "shared-observer", async (e) => void seen.push(e.id));
      secondary.observe("claims.updated", "shared-observer", async (e) => void seen.push(e.id));

      primary.startDelivery();
      const probe = await connect(databaseUrl);
      try {
        // Confirm primary owns RELAY_LOCK before starting secondary.
        await expect
          .poll(
            async () => {
              const { rows } = await probe.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
                RELAY_LOCK,
              ]);
              if (rows[0]?.locked) await probe.query("SELECT pg_advisory_unlock($1)", [RELAY_LOCK]);
              return rows[0]?.locked;
            },
            { timeout: 5_000, interval: 50 },
          )
          .toBe(false);

        secondary.startDelivery();
        const event = claimsEvent();
        await writeOutbox(probe, [event]);
        // Secondary's settle() waits for primary's relay and consumer groups to finish without bypassing RELAY_LOCK.
        await secondary.settle();
        expect(seen).toEqual([event.id]);
      } finally {
        await secondary.close();
        await primary.close();
        await probe.end();
      }
    },
  );
});
