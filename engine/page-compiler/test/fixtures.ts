import { join } from "node:path";
import {
  type Claim,
  type ClaimEvidence,
  contentHash,
  type GovernanceLevel,
  type KnowledgeStore,
  newId,
  type Placement,
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
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { type ClusterOptions, Topics } from "../src/index.ts";

export const TENANT = "ten_01JC0000000000000000TENANT";
export const SPACE = "spc_01JC00000000000000000SPACE";
const SOURCE = "src_01JC0000000000000000FOLDER";

export type Backend = "memory" | "postgres";

export const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
];

/** A sentence, or a sentence and the fact slot its claim fills. */
export type Sentence = string | [string, string];

/** A section of a test document: a heading and its sentences, one claim each. */
export interface Part {
  heading: string;
  sentences: Sentence[];
}

export interface World {
  store: KnowledgeStore;
  records: Records;
  gateway: Gateway;
  topics: Topics;
  /**
   * Store a version of a document the way normalization and extraction leave it (block and
   * span IDs stable across versions, one claim per sentence, claims of removed sentences
   * retracted), then update its sections as claims.updated would.
   */
  doc: (
    externalId: string,
    parts: readonly Part[],
    options?: {
      level?: GovernanceLevel;
      approval?: SourceVersion["approval_state"];
      sensitivity?: SensitivityLabel;
      deleted?: boolean;
      space?: string;
      /** False stores the version without updating its sections. */
      update?: boolean;
    },
  ) => Promise<SourceVersion>;
  /** The current claim stating this sentence. */
  claim: (sentence: string) => Promise<Claim>;
  placement: (sentence: string) => Promise<Placement | undefined>;
  /** Model calls so far, with their task and sensitivity. */
  calls: () => { operation: string; task?: string; sensitivity: SensitivityLabel }[];
}

export const topicsTest = (backend: Backend, cluster: Partial<ClusterOptions> = {}) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    let seconds = 0;
    const clock = () => new Date(Date.UTC(2026, 9, 1) + ++seconds * 1000);
    const gateway = await Gateway.create(loadGatewayConfig(join(workspaceRoot(), "config", "gateway.dev.yaml")));
    let store: MemoryStore | PostgresStore;
    let records: Records;
    if (backend === "memory") {
      store = new MemoryStore({ clock });
      records = new MemoryRecords();
      onCleanup(() => gateway.close());
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      onCleanup(async () => {
        await gateway.close();
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool, { clock });
      records = new PgRecords(pool);
    }
    const topics = new Topics({ store, records, models: gateway, clock, cluster });
    const last = new Map<string, { blocks: SourceBlock[]; claims: Map<string, Claim> }>();
    const bySentence = new Map<string, string>();
    let tick = 0;

    const doc: World["doc"] = async (externalId, parts, options = {}) => {
      const previous = last.get(externalId);
      tick++;
      const version: SourceVersion = {
        id: newId("source_version"),
        tenant_id: TENANT,
        source_id: SOURCE,
        space_id: options.space ?? SPACE,
        external_id: externalId,
        version: { content_hash: contentHash(JSON.stringify(parts)) },
        title: externalId,
        mime_type: "text/markdown",
        approval_state: options.approval ?? "approved",
        authority: 0.9,
        sensitivity: options.sensitivity ?? "internal",
        language: "zh",
        fetched_at: new Date(Date.UTC(2026, 9, 1, 0, tick)).toISOString(),
        ...(options.level && { governance_level: options.level }),
        ...(options.deleted && { deleted: true }),
      };
      const known = new Set(previous?.blocks.flatMap((b) => b.span_ids));
      const blocks: SourceBlock[] = [];
      const spans: Span[] = [];
      const claims = new Map<string, Claim>();
      const evidence: ClaimEvidence[] = [];
      for (const part of options.deleted ? [] : parts) {
        const blockId = stableId("source_block", SOURCE, externalId, part.heading);
        const texts = part.sentences.map((s) => (typeof s === "string" ? s : s[0]));
        const ids = texts.map((text, n) => stableId("span", blockId, text, String(n)));
        blocks.push({
          id: blockId,
          tenant_id: TENANT,
          source_version_id: version.id,
          kind: "paragraph",
          anchor: part.heading,
          text: texts.join(""),
          text_hash: contentHash(texts.join("")),
          ordinal: blocks.length,
          span_ids: ids,
          heading_path: [externalId, part.heading],
        });
        part.sentences.forEach((s, n) => {
          const [text, slot] = typeof s === "string" ? [s, undefined] : s;
          const spanId = ids[n] as string;
          const id = stableId("claim", TENANT, spanId);
          bySentence.set(text, id);
          const kept = previous?.claims.get(id);
          if (kept) {
            claims.set(id, kept);
            return;
          }
          if (!known.has(spanId)) {
            spans.push({
              id: spanId,
              tenant_id: TENANT,
              source_version_id: version.id,
              block_id: blockId,
              locator: { block_anchor: part.heading, kind: "text_range" },
              text,
              text_hash: contentHash(text),
              ordinal: spans.length,
            });
          }
          const at = clock().toISOString();
          claims.set(id, {
            id,
            tenant_id: TENANT,
            space_id: version.space_id,
            statement: text,
            claim_type: "rule",
            knowledge_class: "policy",
            valid_time: {},
            recorded_at: at,
            confidence: 0.9,
            authority: 0.9,
            weight: 0.81,
            status: "active",
            origin: "extracted",
            sensitivity: version.sensitivity,
            inputs_hash: contentHash(text),
            ...(slot && { predicate: slot, slot_key: slot }),
          });
          evidence.push({
            claim_id: id,
            span_id: spanId,
            source_version_id: version.id,
            role: "supports",
            quote: text,
          });
        });
      }
      const fresh = [...claims.values()].filter((c) => !previous?.claims.has(c.id));
      const gone = [...(previous?.claims.values() ?? [])].filter((c) => !claims.has(c.id));
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(version);
        await tx.putBlocks(version.id, blocks, spans);
        if (fresh.length) await tx.upsertClaims(fresh, evidence);
        const now = clock().toISOString();
        if (gone.length) {
          await tx.upsertClaims(
            gone.map((c) => ({ ...c, status: "retracted" as const, superseded_at: now, updated_at: now })),
            [],
          );
        }
      });
      last.set(externalId, { blocks, claims });
      if (options.update !== false) await topics.update(version);
      return version;
    };

    const claimOf = (sentence: string) => {
      const id = bySentence.get(sentence);
      if (!id) throw new RangeError(`no claim states ${sentence}`);
      return id;
    };

    return {
      store,
      records,
      gateway,
      topics,
      doc,
      claim: async (sentence) => (await store.getClaims([claimOf(sentence)]))[0] as Claim,
      placement: async (sentence) => (await store.placementsOf([claimOf(sentence)]))[0],
      calls: () =>
        (gateway.usage as MemoryUsage).records.map((r) => ({
          operation: r.operation,
          ...(r.task && { task: r.task }),
          sensitivity: r.sensitivity,
        })),
    };
  });

/** Sentences about a subject that share its words, as sections about one thing do. */
export function about(subject: string, n: number, offset = 0): string[] {
  const say = [
    `${subject} follows the company rules.`,
    `${subject} is approved by the head of the department.`,
    `${subject} standards are reviewed once a year.`,
    `Questions on ${subject.toLowerCase()} go to HR.`,
    `${subject} requests are filed in the system.`,
    `${subject} records are kept for three years.`,
  ];
  return Array.from({ length: n }, (_, i) => say[(i + offset) % say.length] as string).map(
    (s, i) => `${s.slice(0, -1)} (article ${offset + i + 1}).`,
  );
}
