import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEvent, newId, type Principal, type TodoRequested } from "@inspiration/contracts";
import { RELAY_LOCK, writeOutbox } from "@inspiration/eventbus";
import { connect, type Queryable } from "@inspiration/kernel";
import { Sample } from "@inspiration/knowledge-store/testing";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Engine, SERVER_VISIBILITY_TIMEOUT_MS, serveApi } from "../src/index.ts";
import { resolveTodo, waitForTodos } from "../src/todos.ts";

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

test.each(["resolve", "undo"])("service mode reports when a conflict %s takes effect", async (action) => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  const kb = new Sample({ tenantId: TENANT });
  const ownerId = newId("member");
  const owner: Principal = { kind: "member", id: ownerId, tenant_id: TENANT };
  const [sv1, [span1]] = kb.sourceVersion(["Hotel cap is 600 yuan a night."]);
  const [sv2, [span2]] = kb.sourceVersion(["Hotel cap is 800 yuan a night."], { authority: 0.6 });
  const [c1, e1] = kb.claim("Hotel cap is 600 yuan a night.", span1, {
    predicate: "hotel_cap",
    slot_key: "hotel_cap",
    value: { kind: "money", number: 600, unit: "CNY/night", currency: "CNY", normalized: "600 CNY/night" },
  });
  const [c2, e2] = kb.claim("Hotel cap is 800 yuan a night.", span2, {
    authority: sv2.authority,
    predicate: "hotel_cap",
    slot_key: "hotel_cap",
    value: { kind: "money", number: 800, unit: "CNY/night", currency: "CNY", normalized: "800 CNY/night" },
  });

  let resume: (() => void) | undefined;
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

    if (action === "undo") {
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const resolved = engine.governance.resolved.bind(engine.governance);
      vi.spyOn(engine.governance, "resolved").mockImplementation(async (event) => {
        await gate;
        return resolved(event);
      });
      const [decision] = (await engine.assistant.decide(owner, { todo_ids: [conflict.todo.id] })).decisions;
      if (!decision) throw new Error("expected an assistant decision");
      const server = await serveApi(engine, 0, { devHeaders: true });
      try {
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}/v0/decisions/${decision.id}/undo`, {
          method: "POST",
          headers: { "x-inspiration-tenant": TENANT, "x-inspiration-member": ownerId },
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ pending: true, todo: { status: "open" } });
      } finally {
        server.close();
      }
      resume?.();
      await engine.settle();
      expect((await engine.governance.verdicts(TENANT, ["hotel_cap"]))[0]?.disputed).toBe(true);
      return;
    }

    // The very next read must already reflect the chosen value.
    const result = await resolveTodo(engine, owner, conflict.todo.id, { with: chosen });
    expect(result.todo?.status).toBe("done");
    expect((await engine.governance.verdicts(TENANT, ["hotel_cap"]))[0]?.disputed).toBe(false);
    expect(await engine.governance.conflicts(TENANT, "open")).toEqual([]);
  } finally {
    resume?.();
    await engine.close();
  }
});

test("service mode settle() rejects when background delivery stays pending beyond its budget", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  engine.observe("claims.updated", "blocked-observer", async () => {
    started = true;
    await gate;
  });

  engine.startDelivery();
  try {
    await engine.transport.send([claimsEvent()]);
    await expect.poll(() => started, { timeout: 2_000, interval: 10 }).toBe(true);
    await expect(engine.settle(2)).rejects.toThrow(/pending/);
    release();
    await expect(engine.settle()).resolves.toBe(0);
  } finally {
    release();
    await engine.close();
  }
});

test("HTTP conflict resolution returns 200 when another tenant stays busy, and 202 when its own governance effect is still pending", async () => {
  const engine = await Engine.open({ blobDir: await tempBlobs(), deliveryMode: "service" });
  const tenantA = TENANT;
  const tenantB = "ten_01JC0000000000000000000002";
  const ownerId = newId("member");
  const kb = new Sample({ tenantId: tenantA });
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
  const [sv3, [span3]] = kb.sourceVersion(["Meal cap is 100 yuan a day."]);
  const [sv4, [span4]] = kb.sourceVersion(["Meal cap is 150 yuan a day."]);
  const [c3, e3] = kb.claim("Meal cap is 100 yuan a day.", span3, {
    predicate: "meal_cap",
    slot_key: "meal_cap",
    value: { kind: "money", number: 100, unit: "CNY/day", currency: "CNY", normalized: "100 CNY/day" },
  });
  const [c4, e4] = kb.claim("Meal cap is 150 yuan a day.", span4, {
    predicate: "meal_cap",
    slot_key: "meal_cap",
    value: { kind: "money", number: 150, unit: "CNY/day", currency: "CNY", normalized: "150 CNY/day" },
  });

  let releaseGovernance: (() => void) | undefined;
  let releaseTenantB!: () => void;
  const tenantBGate = new Promise<void>((resolve) => {
    releaseTenantB = resolve;
  });
  let tenantBHeld = false;
  engine.observe("claims.updated", "tenant-b-hold", async (event) => {
    if (event.tenant_id === tenantB) {
      tenantBHeld = true;
      await tenantBGate;
    }
  });

  engine.startDelivery();
  const server = await serveApi(engine, 0, { devHeaders: true });
  const { port } = server.address() as AddressInfo;
  try {
    await engine.directory.putTenant(
      tenantA,
      { name: "Tenant A", kind: "team", default_locale: "en", version: 1 },
      "svc_01TEST000000000000000000",
    );
    await engine.directory.putMember(tenantA, ownerId, {
      display_name: "Owner",
      status: "active",
      roles: ["member"],
      version: 1,
    });
    await engine.directory.createSpace(tenantA, { name: "Travel", owner_ids: [ownerId] }, { spaceId: kb.spaceId });
    await engine.store.transaction(async (tx) => {
      await tx.putSourceVersion(sv1, [span1]);
      await tx.putSourceVersion(sv2, [span2]);
      await tx.putSourceVersion(sv3, [span3]);
      await tx.putSourceVersion(sv4, [span4]);
      await tx.upsertClaims([c1, c2, c3, c4], [...e1, ...e2, ...e3, ...e4]);
      await tx.publish(
        newEvent(
          "claims.updated",
          { origin: "extracted", added: [c1.id, c2.id, c3.id, c4.id], updated: [], superseded: [] },
          { tenantId: tenantA, producer: "extraction" },
        ),
      );
    });
    await engine.settle();

    const items = await engine.inbox.items(tenantA);
    const hotelTodo = items.find((i) => i.todo.status === "open" && i.todo.slot_key === "hotel_cap")?.todo;
    const mealTodo = items.find((i) => i.todo.status === "open" && i.todo.slot_key === "meal_cap")?.todo;
    const hotelChoice = hotelTodo?.resolutions?.[0]?.key;
    const mealChoice = mealTodo?.resolutions?.[0]?.key;
    if (!hotelTodo || !mealTodo || !hotelChoice || !mealChoice) {
      throw new Error("expected open conflict todos for hotel_cap and meal_cap");
    }

    await engine.transport.send([
      newEvent(
        "todo.requested",
        {
          kind: "note",
          title: "Read the travel policy",
          priority: "normal",
          space_id: kb.spaceId,
          unit_ids: [c1.id],
          dedupe_key: "travel-note",
        },
        { tenantId: tenantA, producer: "governance" },
      ),
    ]);
    await engine.settle();
    const note = (await engine.inbox.items(tenantA)).find((i) => i.todo.kind === "note")?.todo;
    if (!note) throw new Error("expected an open note");

    // Keep another tenant busy throughout all three requests.
    await engine.transport.send([
      newEvent(
        "claims.updated",
        { origin: "extracted", added: [newId("claim")], updated: [], superseded: [] },
        { tenantId: tenantB, producer: "extraction" },
      ),
    ]);
    await expect.poll(() => tenantBHeld, { timeout: 2_000, interval: 10 }).toBe(true);

    const settleSpy = vi.spyOn(engine, "settle");
    const headers = {
      "content-type": "application/json",
      "x-inspiration-tenant": tenantA,
      "x-inspiration-member": ownerId,
    };
    const noted = await fetch(`http://127.0.0.1:${port}/v0/todos/${note.id}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "done" }),
    });
    expect(noted.status).toBe(200);
    expect((await engine.inbox.todo(tenantA, note.id))?.status).toBe("done");
    expect(await waitForTodos(engine, [])).toBe(false);

    // Case 1: Tenant A's conflict resolution applies on governance while tenant B stays held.
    // The endpoint must return 200 (not 500) once A's verdict is updated.
    const resApplied = await fetch(`http://127.0.0.1:${port}/v0/todos/${hotelTodo.id}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ with: hotelChoice }),
    });
    expect(resApplied.status).toBe(200);
    const bodyApplied = (await resApplied.json()) as { status: string; pending?: boolean };
    expect(bodyApplied.status).toBe("done");
    expect(bodyApplied.pending).toBeUndefined();
    expect((await engine.governance.verdicts(tenantA, ["hotel_cap"]))[0]?.disputed).toBe(false);

    // Case 2: Hold governance.resolved open so tenant A's own effect is genuinely still pending
    // when the wait budget expires. The endpoint returns 202 with an explicit pending flag.
    const govGate = new Promise<void>((resolve) => {
      releaseGovernance = resolve;
    });
    const realResolved = engine.governance.resolved.bind(engine.governance);
    vi.spyOn(engine.governance, "resolved").mockImplementation(async (event) => {
      await govGate;
      return realResolved(event);
    });

    const resPending = await fetch(`http://127.0.0.1:${port}/v0/todos/${mealTodo.id}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ with: mealChoice }),
    });
    expect(resPending.status).toBe(202);
    const bodyPending = (await resPending.json()) as { status: string; pending?: boolean };
    expect(bodyPending.status).toBe("done");
    expect(bodyPending.pending).toBe(true);

    expect(settleSpy).not.toHaveBeenCalled();
    releaseGovernance?.();
    releaseTenantB();
    settleSpy.mockRestore();
    await engine.settle();
    expect((await engine.governance.verdicts(tenantA, ["meal_cap"]))[0]?.disputed).toBe(false);
  } finally {
    releaseGovernance?.();
    releaseTenantB();
    server.close();
    await engine.close();
  }
});

// Acquiring the lock to probe it can send the relay into standby during startup.
async function relayLocked(db: Queryable): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = 0 AND objid = $1 AND objsubid = 1`,
    [RELAY_LOCK],
  );
  return rowCount === 1;
}

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
        await expect.poll(() => relayLocked(probe), { timeout: 5_000, interval: 50 }).toBe(true);

        const event = claimsEvent();
        await writeOutbox(probe, [event]);
        await expect.poll(() => seen, { timeout: 5_000, interval: 50 }).toEqual([event.id]);
      } finally {
        await engine.close();
        // Closing the engine stops OutboxRelay.run() and releases RELAY_LOCK.
        expect(await relayLocked(probe)).toBe(false);
        await probe.end();
      }
    },
  );

  stackTest(
    "a peer cannot withdraw a todo before its slow creation finishes",
    async ({ databaseUrl, streamPrefix, valkey }) => {
      const options = {
        databaseUrl,
        valkeyUrl: VALKEY_URL,
        streamPrefix,
        blobDir: await tempBlobs(),
        deliveryMode: "service" as const,
      };
      const first = await Engine.open(options);
      const peer = await Engine.open(options);
      const db = await connect(databaseUrl);
      const request: TodoRequested = {
        kind: "note",
        title: "Check this note",
        priority: "normal",
        space_id: newId("space"),
        unit_ids: [newId("claim")],
        dedupe_key: "same-note",
      };
      const meta = { tenantId: TENANT, producer: "governance" };
      const create = newEvent("todo.requested", request, meta);
      const withdraw = newEvent("todo.requested", { ...request, withdrawn: true }, meta);
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const release = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const topics = first.store.topics.bind(first.store);
      vi.spyOn(first.store, "topics").mockImplementationOnce(async (...args) => {
        entered();
        await release;
        return topics(...args);
      });
      try {
        first.startDelivery();
        await writeOutbox(db, [create]);
        await held;
        await writeOutbox(db, [withdraw]);
        // A notification during a relay drain can arrive before it starts listening again.
        // Allow for its one-second fallback poll before exercising the competing consumer.
        await expect
          .poll(() => valkey.xlen(`${streamPrefix}:ev:todo.requested`), { timeout: 5_000, interval: 50 })
          .toBe(2);
        // Run the peer's real consumer round while the first handler is still inside the gate.
        expect(await peer.consumer.runOnce("collaboration")).toBe(0);
        peer.startDelivery();
        resume();
        await peer.settle();
        expect(await first.inbox.items(TENANT, { open: true })).toEqual([]);
        expect((await first.inbox.items(TENANT)).map((i) => i.todo.status)).toEqual(["dismissed"]);
      } finally {
        resume();
        await Promise.all([first.close(), peer.close()]);
        await db.end();
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
        await expect.poll(() => relayLocked(probe), { timeout: 5_000, interval: 50 }).toBe(true);

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
