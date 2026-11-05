import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  contentHash,
  type EventEnvelope,
  type KnowledgeStore,
  type ModelGateway,
  type NormalizedDocument,
  newId,
  type SourceVersion,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { LocalBlobStore, openPool } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { Normalization } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
export const SOURCE = "src_01JC0000000000000000FOLDER";
const SPACE = "spc_01JC00000000000000000SPACE";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

/** The built-in parsers need no models; a call means a parser reached for one by mistake. */
export const NO_MODELS: ModelGateway = {
  complete: async () => {
    throw new Error("no model calls in these tests");
  },
  embed: async () => {
    throw new Error("no model calls in these tests");
  },
  rerank: async () => {
    throw new Error("no model calls in these tests");
  },
  ocr: async () => {
    throw new Error("no model calls in these tests");
  },
};

export interface Item {
  external_id: string;
  /** A file's text, stored as a blob for the parser router. */
  text?: string;
  mime_type?: string;
  blocks?: NormalizedDocument["blocks"];
  process?: NormalizedDocument["process"];
  /** Change to make a metadata-only change. */
  metadata?: string;
  /** The external ID unless given. */
  title?: string;
}

export interface World {
  store: KnowledgeStore;
  records: Records;
  blobs: LocalBlobStore;
  normalization: Normalization;
  /** Store a new version of the item the way source sync does, after its last one. */
  ingest: (item: Item, options?: { deleted?: boolean }) => Promise<SourceVersion>;
  events: () => Promise<EventEnvelope[]>;
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
};

export const normalizationTest = (backend: Backend) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-normalization-"));
    const cleanups: (() => Promise<unknown>)[] = [() => rm(dir, { recursive: true, force: true })];
    onCleanup(async () => {
      for (const c of cleanups.reverse()) await c();
    });
    let store: MemoryStore | PostgresStore;
    let records: Records;
    let events: () => Promise<EventEnvelope[]>;
    if (backend === "memory") {
      const memory = new MemoryStore();
      store = memory;
      records = new MemoryRecords();
      events = async () => [...memory.published];
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      cleanups.push(async () => {
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool);
      records = new PgRecords(pool);
      events = async () =>
        (await pool.query<{ envelope: EventEnvelope }>("SELECT envelope FROM bus.outbox ORDER BY seq")).rows.map(
          (r) => r.envelope,
        );
    }
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    const normalization = new Normalization({ store, records, blobs, models: NO_MODELS });
    const last = new Map<string, SourceVersion>();
    let tick = 0;

    const ingest = async (item: Item, options: { deleted?: boolean } = {}): Promise<SourceVersion> => {
      const previous = last.get(item.external_id);
      const ext = item.external_id.split(".").at(-1) ?? "";
      const mimeType = item.mime_type ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
      const data = new TextEncoder().encode(item.text ?? "");
      const version = {
        content_hash: contentHash(item.text ?? canonicalJson(item.blocks ?? item.process ?? null)),
        metadata_hash: contentHash(item.metadata ?? ""),
        acl_hash: contentHash(""),
      };
      const doc: Omit<NormalizedDocument, "acl"> = {
        ref: { source_id: SOURCE, external_id: item.external_id },
        version,
        title: item.title ?? item.external_id,
        mime_type: mimeType,
      };
      if (item.text !== undefined) {
        doc.file = await blobs.put(data, { mimeType, filename: item.external_id.split("/").at(-1) as string });
      }
      if (item.blocks) doc.blocks = item.blocks;
      if (item.process) doc.process = item.process;
      tick++;
      const sv: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: SOURCE,
        space_id: SPACE,
        external_id: item.external_id,
        version,
        title: item.title ?? item.external_id,
        mime_type: mimeType,
        approval_state: "unknown",
        authority: 0.5,
        sensitivity: "internal",
        fetched_at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString(),
      };
      if (previous) sv.previous_version_id = previous.id;
      if (options.deleted) sv.deleted = true;
      else {
        sv.blob = await blobs.put(new TextEncoder().encode(JSON.stringify(doc)), {
          mimeType: "application/vnd.inspiration.document+json",
        });
      }
      await store.transaction((tx) => tx.putSourceVersion(sv));
      last.set(item.external_id, sv);
      return sv;
    };

    return { store, records, blobs, normalization, ingest, events };
  });
