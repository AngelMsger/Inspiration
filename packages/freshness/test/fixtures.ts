import {
  type BlocksChanged,
  type Claim,
  type ClaimEvidence,
  type ClaimsUpdated,
  type ClaimType,
  contentHash,
  type DuplicateDocument,
  type EventEnvelope,
  type KnowledgeStore,
  newEvent,
  newId,
  type ReviewDue,
  type SourceVersion,
  type Span,
  stableId,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { Freshness } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
const SOURCE = "src_01JC0000000000000000FOLDER";
export const SPACE = "spc_01JC00000000000000000SPACE";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

export interface Doc {
  path: string;
  authority?: number;
  approval_state?: SourceVersion["approval_state"];
  /** The day it last changed in its source. */
  modified: string;
  /** Front matter date: a record of that day. */
  date?: string;
}

export interface Said {
  text: string;
  knowledge_class?: string;
  type?: ClaimType;
  /** A plan's day. */
  on?: string;
}

export interface Stored {
  version: SourceVersion;
  claims: Claim[];
  reviews: ReviewDue[];
}

export interface World {
  store: KnowledgeStore;
  records: Records;
  freshness: Freshness;
  /**
   * Store a version of a document with one claim per statement, then deliver its
   * blocks.changed and claims.updated to freshness. The previous version's claims close.
   */
  put: (
    doc: Doc,
    said: readonly Said[],
    options?: { previous?: Stored; duplicates?: { of: Stored; similarity: number }[] },
  ) => Promise<Stored>;
  /** Deliver an event to freshness, as the bus would. */
  deliver: (event: EventEnvelope) => Promise<void>;
  setToday: (day: string) => void;
  /** Every review freshness published, in order. */
  reviews: () => Promise<ReviewDue[]>;
}

export const freshnessTest = (backend: Backend) =>
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
    let now = new Date("2026-10-23T09:00:00Z");
    const freshness = new Freshness({ store, records, clock: () => now });

    const deliver: World["deliver"] = async (event) => {
      const handler = freshness.handlers()[event.type];
      if (handler) await handler(event);
    };

    const put: World["put"] = async (doc, said, options = {}) => {
      const extra = doc.date ? { date: doc.date } : undefined;
      const version: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: SOURCE,
        space_id: SPACE,
        external_id: doc.path,
        version: { content_hash: contentHash(JSON.stringify([doc, said])) },
        title: doc.path.replace(/\.md$/, ""),
        mime_type: "text/markdown",
        approval_state: doc.approval_state ?? "approved",
        authority: doc.authority ?? 0.5,
        sensitivity: "internal",
        fetched_at: now.toISOString(),
        metadata: { modified_at: `${doc.modified}T08:00:00Z`, ...(extra && { extra }) },
        ...(options.previous && { previous_version_id: options.previous.version.id }),
      };
      const spans: Span[] = [];
      const claims: Claim[] = [];
      const evidence: ClaimEvidence[] = [];
      for (const [i, s] of said.entries()) {
        const span: Span = {
          id: stableId("span", version.id, String(i)),
          tenant_id: TENANT,
          source_version_id: version.id,
          locator: { kind: "text_range", block_anchor: `p${i}` },
          text: s.text,
          text_hash: contentHash(s.text),
          ordinal: i,
        };
        spans.push(span);
        const claim: Claim = {
          id: stableId("claim", version.id, s.text),
          tenant_id: TENANT,
          space_id: SPACE,
          statement: s.text,
          claim_type: s.type ?? (s.on ? "plan" : "rule"),
          knowledge_class: s.knowledge_class ?? "general",
          valid_time: s.on ? { start: `${s.on}T00:00:00Z` } : {},
          recorded_at: now.toISOString(),
          confidence: 0.9,
          authority: version.authority,
          weight: version.authority,
          status: "active",
          origin: "extracted",
          sensitivity: "internal",
          inputs_hash: contentHash(s.text),
        };
        claims.push(claim);
        evidence.push({
          claim_id: claim.id,
          span_id: span.id,
          source_version_id: version.id,
          role: "supports",
          quote: s.text,
        });
      }
      const closed = options.previous?.claims ?? [];
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(version, spans);
        await tx.upsertClaims(claims, evidence);
        if (closed.length)
          await tx.upsertClaims(
            closed.map((c) => ({ ...c, status: "retracted" as const, superseded_at: now.toISOString() })),
            [],
          );
      });
      const before = (await outbox()).length;
      const duplicates: DuplicateDocument[] = (options.duplicates ?? []).map((d) => ({
        source_id: SOURCE,
        external_id: d.of.version.external_id,
        source_version_id: d.of.version.id,
        exact: d.similarity === 1,
        similarity: d.similarity,
      }));
      const change: BlocksChanged = {
        source_id: SOURCE,
        source_version_id: version.id,
        added_block_ids: [],
        changed_block_ids: [],
        removed_block_ids: [],
        unchanged_block_count: 0,
        added_span_ids: spans.map((s) => s.id),
        removed_span_ids: [],
        ...(options.previous && { previous_version_id: options.previous.version.id }),
        ...(duplicates.length && { duplicates }),
      };
      const update: ClaimsUpdated = {
        origin: "extracted",
        added: claims.map((c) => c.id),
        updated: [],
        superseded: closed.map((c) => c.id),
        source_version_id: version.id,
      };
      await deliver(newEvent("blocks.changed", change, { tenantId: TENANT, producer: "normalization" }));
      await deliver(newEvent("claims.updated", update, { tenantId: TENANT, producer: "extraction" }));
      const reviews = (await outbox())
        .slice(before)
        .filter((e) => e.type === "review.due")
        .map((e) => e.data as unknown as ReviewDue);
      return { version, claims, reviews };
    };

    const setToday = (day: string) => {
      now = new Date(`${day}T09:00:00Z`);
    };
    const reviews = async () =>
      (await outbox()).filter((e) => e.type === "review.due").map((e) => e.data as unknown as ReviewDue);
    return { store, records, freshness, put, deliver, setToday, reviews };
  });
