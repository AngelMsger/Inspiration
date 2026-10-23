import {
  type Claim,
  type ClaimEvidence,
  type ClaimsUpdated,
  type ClaimType,
  contentHash,
  type EventEnvelope,
  type KnowledgeStore,
  newEvent,
  newId,
  type SourceVersion,
  type Span,
  stableId,
  type TodoRequested,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { Governance, type GovernanceResult } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
const SOURCE = "src_01JC0000000000000000FOLDER";
export const SPACE = "spc_01JC00000000000000000SPACE";
export const TODAY = new Date("2026-10-23T09:00:00Z");

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

/** A statement a document makes about the first-tier city hotel cap. */
export interface Said {
  text: string;
  value: number;
  /** The day the statement says it takes effect. */
  from?: string;
  type?: ClaimType;
  slot?: string;
}

export interface Doc {
  title: string;
  authority: number;
  approval_state?: SourceVersion["approval_state"];
  /** Front matter effective_from. */
  effective_from?: string;
}

export interface World {
  store: KnowledgeStore;
  records: Records;
  governance: Governance;
  /** Store a document's claims the way extraction does, then let governance apply the update. */
  state: (
    doc: Doc,
    said: readonly Said[],
  ) => Promise<{ claims: Claim[]; event: EventEnvelope; result: GovernanceResult }>;
  /** Close claims, as extraction does when their evidence goes away. */
  close: (claims: readonly Claim[]) => Promise<GovernanceResult>;
  /** Every todo request governance published, in order. */
  requests: () => Promise<TodoRequested[]>;
  /** Move governance's clock. */
  setToday: (day: string) => void;
}

export const HOTEL = "hotel_cap_per_night|一线城市";

export const governanceTest = (backend: Backend) =>
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
    let now = TODAY;
    const governance = new Governance({ store, records, clock: () => now });

    const state: World["state"] = async (doc, said) => {
      const version: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: SOURCE,
        space_id: SPACE,
        external_id: `${doc.title}.md`,
        version: { content_hash: contentHash(JSON.stringify([doc, said])) },
        title: doc.title,
        mime_type: "text/markdown",
        approval_state: doc.approval_state ?? "approved",
        authority: doc.authority,
        sensitivity: "internal",
        fetched_at: TODAY.toISOString(),
        ...(doc.effective_from && { metadata: { extra: { effective_from: doc.effective_from } } }),
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
        const [predicate, ...qualifiers] = (s.slot ?? HOTEL).split("|") as [string, ...string[]];
        const start = s.from ?? doc.effective_from;
        const claim: Claim = {
          id: stableId("claim", version.id, s.text),
          tenant_id: TENANT,
          space_id: SPACE,
          statement: s.text,
          claim_type: s.type ?? "rule",
          knowledge_class: "policy",
          predicate,
          ...(qualifiers.length && { qualifiers }),
          value: {
            kind: "money",
            number: s.value,
            unit: "CNY/night",
            currency: "CNY",
            normalized: `${s.value} CNY/night`,
          },
          valid_time: start ? { start: `${start}T00:00:00Z` } : {},
          recorded_at: TODAY.toISOString(),
          confidence: 0.9,
          authority: doc.authority,
          weight: doc.authority * 0.9,
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
      const update: ClaimsUpdated = {
        origin: "extracted",
        added: claims.map((c) => c.id),
        updated: [],
        superseded: [],
        source_version_id: version.id,
      };
      const event = newEvent("claims.updated", update, { tenantId: TENANT, producer: "extraction" });
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(version, spans);
        await tx.upsertClaims(claims, evidence);
      });
      return { claims, event, result: await governance.apply(event) };
    };

    const close: World["close"] = async (claims) => {
      const now = TODAY.toISOString();
      await store.transaction(async (tx) => {
        await tx.upsertClaims(
          claims.map((c) => ({ ...c, status: "retracted" as const, superseded_at: now })),
          [],
        );
      });
      const update: ClaimsUpdated = {
        origin: "extracted",
        added: [],
        updated: [],
        superseded: claims.map((c) => c.id),
      };
      return governance.apply(newEvent("claims.updated", update, { tenantId: TENANT, producer: "extraction" }));
    };

    const requests = async () =>
      (await outbox()).filter((e) => e.type === "todo.requested").map((e) => e.data as unknown as TodoRequested);

    const setToday = (day: string) => {
      now = new Date(`${day}T09:00:00Z`);
    };
    return { store, records, governance, state, close, requests, setToday };
  });
