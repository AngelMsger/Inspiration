import {
  type Claim,
  type EventEnvelope,
  type KnowledgeStore,
  newEvent,
  type ReviewDue,
  type SourceVersion,
  type TaxonomyNode,
  type TodoCreated,
  type TodoRequested,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { Sample } from "@inspiration/knowledge-store/testing";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { Inbox, type InboxSettings } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
export const SPACE = "spc_01JC00000000000000000SPACE";
export const LI = "mem_01JC000000000000000000LINA";
export const WANG = "mem_01JC00000000000000WANGWEI";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

export interface World {
  store: KnowledgeStore;
  records: Records;
  inbox: Inbox;
  /** Store topics, the parents first. */
  topics: (...nodes: Partial<TaxonomyNode>[]) => Promise<TaxonomyNode[]>;
  /** A governed document with one claim per statement, its claims placed in the topic when one is given. */
  document: (statements: readonly string[], topic?: string) => Promise<{ version: SourceVersion; claims: Claim[] }>;
  /** Deliver a todo request, as governance would publish it. */
  request: (
    request: Omit<Partial<TodoRequested>, "unit_ids"> & { unit_ids: string[] },
    correlation?: string,
  ) => Promise<void>;
  /** Deliver a due review, as freshness would publish it. */
  review: (
    review: Omit<Partial<ReviewDue>, "unit_ids"> & { unit_ids: string[] },
    correlation?: string,
  ) => Promise<void>;
  deliver: (event: EventEnvelope) => Promise<void>;
  setToday: (day: string) => void;
  /** Every todo.created the inbox published, in order. */
  created: () => Promise<TodoCreated[]>;
}

export const inboxTest = (backend: Backend, settings: Partial<InboxSettings> = {}) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    let store: MemoryStore | PostgresStore;
    let records: Records;
    let outbox: () => Promise<EventEnvelope[]>;
    if (backend === "memory") {
      store = new MemoryStore();
      const memory = new MemoryRecords();
      records = memory;
      outbox = async () => [...memory.published];
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      onCleanup(async () => {
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool);
      records = new PgRecords(pool);
      outbox = async () =>
        (await pool.query<{ envelope: EventEnvelope }>("SELECT envelope FROM bus.outbox ORDER BY seq")).rows.map(
          (r) => r.envelope,
        );
    }
    // Friday of 2026-W43.
    let now = new Date("2026-10-23T09:00:00Z");
    const inbox = new Inbox({ store, records, clock: () => now, settings });
    const sample = new Sample({ tenantId: TENANT, spaceId: SPACE });
    let documents = 0;

    const topics: World["topics"] = async (...nodes) => {
      const out = nodes.map((n, i) => sample.topic(n.key as string, { ordinal: i, ...n }));
      await store.transaction((tx) => tx.putTopics(out));
      return out;
    };

    const document: World["document"] = async (statements, topic) => {
      const [version, spans] = sample.sourceVersion(statements, { external_id: `doc-${++documents}` });
      const pairs = spans.map((s) => sample.claim(s.text, s));
      const claims = pairs.map(([c]) => c);
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(version, spans);
        await tx.upsertClaims(
          claims,
          pairs.flatMap(([, e]) => e),
        );
        if (topic) await tx.place(claims.map((c) => sample.placement(c, topic)));
      });
      return { version, claims };
    };

    const deliver: World["deliver"] = async (event) => {
      const handler = inbox.handlers()[event.type];
      if (handler) await handler(event);
    };

    const envelope = <T extends "todo.requested" | "review.due">(
      type: T,
      data: T extends "todo.requested" ? TodoRequested : ReviewDue,
      producer: string,
      correlation?: string,
    ) => {
      const event = newEvent(type, data as never, { tenantId: TENANT, producer, occurredAt: now });
      return correlation ? { ...event, correlation_id: correlation } : event;
    };

    const request: World["request"] = async (r, correlation) => {
      const data: TodoRequested = {
        kind: "conflict",
        space_id: SPACE,
        title: "hotel_cap_per_night (一线城市): 650 CNY/night or 600 CNY/night",
        priority: "normal",
        dedupe_key: `governance:conflict:${r.unit_ids.join(",")}`,
        ...r,
        unit_ids: r.unit_ids as [string, ...string[]],
      };
      await deliver(envelope("todo.requested", data, "governance", correlation));
    };

    const review: World["review"] = async (r, correlation) => {
      const data: ReviewDue = {
        kind: "ttl",
        due_at: now.toISOString(),
        space_id: SPACE,
        reason: "差旅费管理办法 last changed on 2025-10-01; documents with policy claims are reviewed every 365 days.",
        dedupe_key: `freshness:ttl:${r.unit_ids.join(",")}`,
        ...r,
        unit_ids: r.unit_ids as [string, ...string[]],
      };
      await deliver(envelope("review.due", data, "freshness", correlation));
    };

    const setToday = (day: string) => {
      now = new Date(`${day}T09:00:00Z`);
    };
    const created = async () =>
      (await outbox()).filter((e) => e.type === "todo.created").map((e) => e.data as unknown as TodoCreated);
    return { store, records, inbox, topics, document, request, review, deliver, setToday, created };
  });
