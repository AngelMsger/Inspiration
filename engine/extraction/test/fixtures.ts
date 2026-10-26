import { join } from "node:path";
import {
  type BlocksChanged,
  contentHash,
  type EventEnvelope,
  type GovernanceLevel,
  type KnowledgeStore,
  newId,
  type SensitivityLabel,
  type SourceBlock,
  type SourceVersion,
  type Span,
  stableId,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool, workspaceRoot } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { Gateway, loadGatewayConfig, type MemoryUsage } from "@inspiration/model-gateway";
import { createTestDatabase, hasStack, testData } from "@inspiration/testkit";
import { test } from "vitest";
import { Extraction, type ExtractionResult, parseVocabulary, type Vocabulary } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
const SOURCE = "src_01JC0000000000000000FOLDER";
const SPACE = "spc_01JC00000000000000000SPACE";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

/** The catalogue the tests use: a hotel cap per night by city tier, a claim deadline and a payment day. */
export const VOCABULARY: Vocabulary = parseVocabulary(
  testData<{ vocabulary: unknown }>(import.meta.url, "en.yaml").vocabulary,
);

/** A block of a test document. Paragraph sentences end at a full stop and a space; table rows separate cells with tabs. */
export interface Para {
  id: string;
  text: string;
  heading?: string[];
  kind?: "paragraph" | "list_item" | "table" | "table_row";
  /** A table row's table. */
  table?: string;
  /** On a table: how many header rows it has. */
  header_rows?: number;
}

export interface World {
  store: KnowledgeStore;
  gateway: Gateway;
  extraction: Extraction;
  /**
   * Store a version of a document with these blocks the way normalization does (block and
   * span IDs stable across versions), then extract from its block diff.
   */
  version: (
    externalId: string,
    paras: readonly Para[],
    options?: {
      deleted?: boolean;
      sensitivity?: SensitivityLabel;
      effectiveFrom?: string;
      cause?: EventEnvelope;
      level?: GovernanceLevel;
    },
  ) => Promise<{ version: SourceVersion; change: BlocksChanged; result: ExtractionResult }>;
  events: () => Promise<EventEnvelope[]>;
  /** The sensitivity of every model call so far. */
  routed: () => SensitivityLabel[];
}

function pieces(para: Para): string[] {
  if (para.kind === "table") return [];
  if (para.kind === "table_row") return para.text.split("\t");
  return para.text.split(/(?<=[.?!])\s+/).filter(Boolean);
}

export const extractionTest = (backend: Backend) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    // Every reading of the clock is a second later, so known-when intervals never collapse.
    let seconds = 0;
    const clock = () => new Date(Date.UTC(2026, 9, 1) + ++seconds * 1000);
    let store: MemoryStore | PostgresStore;
    let records: Records;
    let events: () => Promise<EventEnvelope[]>;
    if (backend === "memory") {
      const memory = new MemoryStore({ clock });
      store = memory;
      records = new MemoryRecords();
      events = async () => [...memory.published];
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      onCleanup(async () => {
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool, { clock });
      records = new PgRecords(pool);
      events = async () =>
        (await pool.query<{ envelope: EventEnvelope }>("SELECT envelope FROM bus.outbox ORDER BY seq")).rows.map(
          (r) => r.envelope,
        );
    }
    const gateway = await Gateway.create(loadGatewayConfig(join(workspaceRoot(), "config", "gateway.dev.yaml")));
    const extraction = new Extraction({ store, records, models: gateway, vocabulary: () => VOCABULARY, clock });
    const last = new Map<string, { version: SourceVersion; blocks: SourceBlock[] }>();
    let tick = 0;

    const version: World["version"] = async (externalId, paras, options = {}) => {
      const previous = last.get(externalId);
      tick++;
      const sv: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: SOURCE,
        space_id: SPACE,
        external_id: externalId,
        version: { content_hash: contentHash(JSON.stringify(paras)) },
        title: externalId,
        mime_type: "text/markdown",
        approval_state: "approved",
        authority: 0.9,
        sensitivity: options.sensitivity ?? "internal",
        fetched_at: new Date(Date.UTC(2026, 9, 1, 0, tick)).toISOString(),
        ...(previous && { previous_version_id: previous.version.id }),
        ...(options.deleted && { deleted: true }),
        ...(options.level && { governance_level: options.level }),
        ...(options.effectiveFrom && { metadata: { extra: { effective_from: options.effectiveFrom } } }),
      };
      const known = new Set(previous?.blocks.flatMap((b) => b.span_ids));
      const blocks: SourceBlock[] = [];
      const spans: Span[] = [];
      const idOf = (p: string) => stableId("source_block", SOURCE, externalId, p);
      for (const [ordinal, para] of (options.deleted ? [] : paras).entries()) {
        const blockId = idOf(para.id);
        const ids: string[] = [];
        for (const [n, text] of pieces(para).entries()) {
          const id = stableId("span", blockId, text, String(n));
          ids.push(id);
          if (known.has(id) || spans.some((s) => s.id === id)) continue;
          spans.push({
            id,
            tenant_id: TENANT,
            source_version_id: sv.id,
            block_id: blockId,
            locator: { block_anchor: para.id, kind: para.kind === "table_row" ? "table_cell" : "text_range" },
            text,
            text_hash: contentHash(text),
            ordinal: spans.length,
          });
        }
        blocks.push({
          id: blockId,
          tenant_id: TENANT,
          source_version_id: sv.id,
          kind: para.kind ?? "paragraph",
          anchor: para.id,
          text: para.text,
          text_hash: contentHash(para.text),
          ordinal,
          span_ids: ids,
          ...(para.heading && { heading_path: para.heading }),
          ...(para.table && { parent_id: idOf(para.table) }),
          ...(para.header_rows !== undefined && { attrs: { header_rows: para.header_rows } }),
        });
      }
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(sv);
        await tx.putBlocks(sv.id, blocks, spans);
      });
      const before = new Map(previous?.blocks.map((b) => [b.id, b]));
      const now = new Set(blocks.map((b) => b.id));
      const current = new Set(blocks.flatMap((b) => b.span_ids));
      const change: BlocksChanged = {
        source_id: SOURCE,
        source_version_id: sv.id,
        added_block_ids: blocks.filter((b) => !before.has(b.id)).map((b) => b.id),
        // As normalization does: a block under other headings is changed too.
        changed_block_ids: blocks
          .filter((b) => {
            const old = before.get(b.id);
            return old && (old.text !== b.text || String(old.heading_path) !== String(b.heading_path));
          })
          .map((b) => b.id),
        removed_block_ids: [...before.keys()].filter((id) => !now.has(id)),
        added_span_ids: [...current].filter((id) => !known.has(id)),
        removed_span_ids: [...known].filter((id) => !current.has(id)),
        ...(previous && { previous_version_id: previous.version.id }),
        ...(options.deleted && { deleted: true }),
      };
      last.set(externalId, { version: sv, blocks });
      return { version: sv, change, result: await extraction.extract(change, options.cause) };
    };

    return {
      store,
      gateway,
      extraction,
      version,
      events,
      routed: () => (gateway.usage as MemoryUsage).records.map((r) => r.sensitivity),
    };
  });
