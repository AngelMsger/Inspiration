import { join } from "node:path";
import { AuthzService, MemoryGraph } from "@inspiration/access-control";
import {
  type Claim,
  type ClaimEvidence,
  contentHash,
  type EventEnvelope,
  type GovernanceLevel,
  type KnowledgeStore,
  newEvent,
  newId,
  type Principal,
  type SensitivityLabel,
  type SlotVerdict,
  type SourceBlock,
  type SourceVersion,
  type Span,
  type Staleness,
  stableId,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool, workspaceRoot } from "@inspiration/kernel";
import {
  MemoryKeywordIndex,
  MemoryStore,
  MemoryVectorIndex,
  PgSearchIndex,
  PgVectorIndex,
  PostgresStore,
} from "@inspiration/knowledge-store";
import { Gateway, loadGatewayConfig } from "@inspiration/model-gateway";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { type Baseline, Retrieval, type RetrievalOptions } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
export const SPACE = "spc_01JC00000000000000000SPACE";
/** A second space every member reads, with no documents. */
export const EMPTY_SPACE = "spc_01JC0000000000000000EMPTY1";
export const SOURCE = "src_01JC0000000000000000FOLDER";
/** Alice's own space and its source: only she reads it until it is shared. */
export const PRIVATE_SPACE = "spc_01JC000000000000000PRIVATE";
export const PRIVATE_SOURCE = "src_01JC000000000000000PRIVATE";
export const HOTEL = "hotel_cap_per_night|tier-1 city";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

const member = (name: string): Principal => ({
  id: `mem_01JC0000000000000${name.toUpperCase().padStart(7, "0")}`,
  kind: "member",
  tenant_id: TENANT,
});

/** alice and bob are members of the tenant and read the space; carol is cleared for confidential; alice alone reads her private space. */
export const ALICE = member("alice");
export const BOB = member("bob");
export const CAROL = member("carol");

export interface Para {
  /** Stable across versions of the document. */
  id: string;
  text: string;
  heading?: boolean;
}

export interface DocOptions {
  title?: string;
  /** In Alice's private space, which only she reads until it is shared; in the space every member reads when not given. */
  private?: true;
  sensitivity?: SensitivityLabel;
  deleted?: boolean;
  language?: string;
  /** When the source says it last changed. */
  modified?: string;
  /** Governed, at authority 0.9, unless given. */
  level?: GovernanceLevel;
  authority?: number;
  /** Documents normalization reports as editions of this one. */
  editions?: readonly Doc[];
  /** False: stored but not indexed yet, so no search finds it, though a statement of it can join an answer. */
  indexed?: false;
}

export interface World {
  store: KnowledgeStore;
  records: Records;
  authz: AuthzService;
  gateway: Gateway;
  retrieval: Retrieval;
  /** A rival over the same chunks, indexes and model. */
  baseline: (kind: Baseline, options?: Partial<RetrievalOptions>) => Retrieval;
  /** The knowledge base as retrieval is, with other options: readAll, contextTokens, models. */
  knowledgeBase: (options: Partial<RetrievalOptions>) => Retrieval;
  /** The verdicts the governance double gives, by slot. */
  verdicts: Map<string, SlotVerdict>;
  /** What the freshness double says of units, by ID; fresh when not here. */
  staleness: Map<string, Staleness>;
  /**
   * Store a version of a document the way normalization does (block and span IDs stable
   * across versions, a span per sentence), then index it.
   */
  document: (externalId: string, paras: readonly Para[], options?: DocOptions) => Promise<Doc>;
  /** Let a member read Alice's private space. */
  share: (member: Principal) => Promise<void>;
  /** Store a claim quoting a span, as extraction does. */
  claim: (statement: string, span: Span, fields?: Partial<Claim> & { quote?: string }) => Promise<Claim>;
}

export interface Doc {
  version: SourceVersion;
  spans: Span[];
  /** The spans of a paragraph, by its ID. */
  spansOf: (paraId: string) => Span[];
  event: EventEnvelope;
}

/** A value of the hotel cap slot. */
export const cap = (n: number): Partial<Claim> => ({
  slot_key: HOTEL,
  predicate: "hotel_cap_per_night",
  qualifiers: ["tier-1 city"],
  value: { kind: "money", number: n, currency: "CNY", unit: "CNY/night", normalized: `${n} CNY/night` },
});

export const retrievalTest = (backend: Backend) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    const cleanups: (() => Promise<unknown>)[] = [];
    onCleanup(async () => {
      for (const c of cleanups.reverse()) await c();
    });
    let store: MemoryStore | PostgresStore;
    let records: Records;
    let vectors: MemoryVectorIndex | PgVectorIndex;
    let keywords: MemoryKeywordIndex | PgSearchIndex;
    if (backend === "memory") {
      const memory = new MemoryStore();
      store = memory;
      records = new MemoryRecords();
      vectors = new MemoryVectorIndex(memory);
      keywords = new MemoryKeywordIndex(memory);
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      cleanups.push(async () => {
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool);
      records = new PgRecords(pool);
      vectors = new PgVectorIndex(pool);
      keywords = new PgSearchIndex(pool);
    }
    const authz = new AuthzService(new MemoryGraph(), store);
    await authz.createSpace(SPACE, { tenantId: TENANT, ownerId: ALICE.id });
    for (const m of [ALICE, BOB, CAROL]) await authz.addTenantMember(TENANT, m.id);
    await authz.grantSpace(SPACE, "viewer", TENANT);
    await authz.createSpace(EMPTY_SPACE, { tenantId: TENANT, ownerId: ALICE.id });
    await authz.grantSpace(EMPTY_SPACE, "viewer", TENANT);
    await authz.createSpace(PRIVATE_SPACE, { tenantId: TENANT, ownerId: ALICE.id });
    await authz.registerSource(PRIVATE_SOURCE, PRIVATE_SPACE);
    await authz.grantClearance(TENANT, CAROL.id, "confidential");
    await authz.registerSource(SOURCE, SPACE);

    const gateway = await Gateway.create(loadGatewayConfig(join(workspaceRoot(), "config", "gateway.dev.yaml")));
    cleanups.push(() => gateway.close());
    const verdicts = new Map<string, SlotVerdict>();
    const staleness = new Map<string, Staleness>();
    const indexes = { store, records, models: gateway, authz, vectors, keywords };
    const governed = {
      ...indexes,
      verdicts: {
        verdicts: async (_tenant: string, slots: readonly string[]) => slots.flatMap((s) => verdicts.get(s) ?? []),
      },
      staleness: {
        staleness: async (_tenant: string, ids: readonly string[]) => ids.flatMap((id) => staleness.get(id) ?? []),
      },
    };
    const retrieval = new Retrieval(governed);
    const baseline: World["baseline"] = (kind, options) => new Retrieval({ ...indexes, ...options, baseline: kind });
    const knowledgeBase: World["knowledgeBase"] = (options) => new Retrieval({ ...governed, ...options });
    const last = new Map<string, SourceVersion>();
    let tick = 0;

    const document: World["document"] = async (externalId, paras, options = {}) => {
      const previous = last.get(externalId);
      const source = options.private ? PRIVATE_SOURCE : SOURCE;
      tick++;
      const version: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: source,
        space_id: options.private ? PRIVATE_SPACE : SPACE,
        external_id: externalId,
        version: {
          content_hash: contentHash(JSON.stringify(paras)),
          ...(options.modified && { modified_at: options.modified }),
        },
        title: options.title ?? externalId,
        mime_type: "text/markdown",
        approval_state: "approved",
        authority: options.authority ?? 0.9,
        ...(options.level && { governance_level: options.level }),
        sensitivity: options.sensitivity ?? "internal",
        fetched_at: new Date(Date.UTC(2026, 9, 1, 0, tick)).toISOString(),
        ...(options.language && { language: options.language }),
        ...(previous && { previous_version_id: previous.id }),
        ...(options.deleted && { deleted: true }),
      };
      const blocks: SourceBlock[] = [];
      const spans: Span[] = [];
      const byPara = new Map<string, Span[]>();
      const path: string[] = [];
      for (const [ordinal, p] of (options.deleted ? [] : paras).entries()) {
        const id = stableId("source_block", source, externalId, p.id);
        const block: SourceBlock = {
          id,
          tenant_id: TENANT,
          source_version_id: version.id,
          kind: p.heading ? "heading" : "paragraph",
          anchor: p.id,
          text: p.text,
          text_hash: contentHash(p.text),
          ordinal,
          span_ids: [],
          ...(path.length && { heading_path: [...path] }),
          ...(p.heading && { level: 1 }),
        };
        if (p.heading) {
          path.splice(0, path.length, p.text);
        } else {
          const own = p.text.split(/(?<=[.?!\u3002\uff1f\uff01])\s*/u).filter(Boolean);
          const mine = own.map(
            (text, i): Span => ({
              id: stableId("span", id, text, String(i)),
              tenant_id: TENANT,
              source_version_id: version.id,
              block_id: id,
              locator: { block_anchor: p.id, kind: "text_range" },
              text,
              text_hash: contentHash(text),
              ordinal: spans.length + i,
            }),
          );
          block.span_ids = mine.map((s) => s.id);
          spans.push(...mine);
          byPara.set(p.id, mine);
        }
        blocks.push(block);
      }
      // Spans an earlier version introduced are stored with it; the blocks only list them.
      const known = new Set(previous ? (await store.spansOf(previous.id)).map((s) => s.id) : []);
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(version);
        await tx.putBlocks(
          version.id,
          blocks,
          spans.filter((s) => !known.has(s.id)),
        );
      });
      const stored = await store.spansOf(version.id);
      const event = newEvent(
        "blocks.changed",
        {
          source_id: source,
          source_version_id: version.id,
          ...(previous && { previous_version_id: previous.id }),
          added_block_ids: blocks.map((b) => b.id),
          changed_block_ids: [],
          removed_block_ids: [],
          added_span_ids: spans.filter((s) => !known.has(s.id)).map((s) => s.id),
          removed_span_ids: [],
          ...(options.deleted && { deleted: true }),
          ...(options.editions?.length && {
            duplicates: options.editions.map((d) => ({
              source_id: d.version.source_id,
              external_id: d.version.external_id,
              source_version_id: d.version.id,
              exact: false,
              similarity: 0.4,
            })),
          }),
        },
        { tenantId: TENANT, producer: "normalization" },
      );
      if (options.indexed !== false) await retrieval.onBlocksChanged(event);
      last.set(externalId, version);
      const byId = new Map(stored.map((s) => [s.id, s]));
      return {
        version,
        spans: stored,
        spansOf: (paraId) => (byPara.get(paraId) ?? []).map((s) => byId.get(s.id) ?? s),
        event,
      };
    };

    const share: World["share"] = async (member) => {
      await authz.grantSpace(PRIVATE_SPACE, "viewer", member.id);
    };

    const claim: World["claim"] = async (statement, span, fields = {}) => {
      const { quote, ...rest } = fields;
      const c: Claim = {
        id: newId("claim"),
        tenant_id: TENANT,
        space_id: SPACE,
        statement,
        claim_type: "rule",
        knowledge_class: "policy",
        valid_time: {},
        recorded_at: new Date(Date.UTC(2026, 9, 1, 1, ++tick)).toISOString(),
        confidence: 0.9,
        authority: 0.9,
        weight: 1,
        status: "active",
        origin: "extracted",
        sensitivity: "internal",
        inputs_hash: contentHash(statement),
        ...rest,
      };
      const q = quote ?? span.text;
      const start = span.text.indexOf(q);
      const evidence: ClaimEvidence = {
        claim_id: c.id,
        span_id: span.id,
        source_version_id: span.source_version_id,
        role: "supports",
        quote: q,
        quote_start: start,
        quote_end: start + q.length,
      };
      await store.transaction((tx) => tx.upsertClaims([c], [evidence]));
      return c;
    };

    return {
      store,
      records,
      authz,
      gateway,
      retrieval,
      baseline,
      knowledgeBase,
      verdicts,
      staleness,
      document,
      share,
      claim,
    };
  });
