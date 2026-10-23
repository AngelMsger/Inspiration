import {
  type BlobStore,
  type BlocksChanged,
  type DocBlock,
  type DocumentFetched,
  type DuplicateDocument,
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  type ModelGateway,
  type NormalizedDocument,
  newEvent,
  type Parser,
  type ProcessSnapshot,
  type ProducerInfo,
  parseAs,
  payloadOf,
  type SourceBlock,
  type SourceVersion,
  type Span,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { logger, registry } from "@inspiration/kernel";
import { build, draftIds, flatten } from "./blocks.ts";
import { align, blockDiff } from "./diff.ts";
import { bands, type Fingerprint, fingerprint, hamming, MIN_NEAR_TEXT, MIN_TEXT, NEAR } from "./fingerprint.ts";

const log = logger("normalization");

export const COMPONENT = "normalization";

/** How a version's blocks were obtained. */
export type DocumentStatus = "structured" | "parsed" | "unchanged" | "unsupported" | "failed" | "deleted";

/** What normalization last stored for a document. */
export interface DocumentState {
  tenant_id: string;
  source_id: string;
  external_id: string;
  source_version_id: string;
  fetched_at: string;
  status: DocumentStatus;
  parser?: ProducerInfo;
  warnings?: string[];
  block_count: number;
  span_count: number;
  fingerprint?: Fingerprint;
  normalized_at: string;
  /** The latest version that could not be parsed, when it is newer than source_version_id. */
  failed?: { source_version_id: string; warnings: string[]; at: string };
}

/** One band of a current document's SimHash, with what a duplicate report needs. */
interface BandRow {
  tenant_id: string;
  band: string;
  document: string;
  source_id: string;
  external_id: string;
  source_version_id: string;
  fingerprint: Fingerprint;
}

export const DOCUMENTS = defineTable<DocumentState>("normalization.documents", {
  key: (d) => documentKey(d.source_id, d.external_id),
  columns: { tenant_id: (d) => d.tenant_id, source_id: (d) => d.source_id, status: (d) => d.status },
});

export const FINGERPRINTS = defineTable<BandRow>("normalization.fingerprints", {
  key: (r) => `${r.band}\x1f${r.document}`,
  columns: { tenant_id: (r) => r.tenant_id, band: (r) => r.band },
});

export function documentKey(sourceId: string, externalId: string): string {
  return `${sourceId}\x1f${externalId}`;
}

export interface NormalizationOptions {
  store: KnowledgeStore;
  records: Records;
  blobs: BlobStore;
  /** For parsers that need OCR or layout models. */
  models: ModelGateway;
  /** The parsers to route between; defaults to every "parsers" plugin. */
  parsers?: readonly Parser[];
  clock?: () => Date;
}

export interface NormalizeResult {
  status: DocumentStatus | "already_normalized";
  diff?: BlocksChanged;
}

const MIME_DOCUMENT = "application/vnd.inspiration.document+json";

export class Normalization {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly models: ModelGateway;
  readonly clock: () => Date;
  readonly #parsers: Promise<readonly Parser[]>;
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: NormalizationOptions) {
    this.store = options.store;
    this.records = options.records;
    this.blobs = options.blobs;
    this.models = options.models;
    this.clock = options.clock ?? (() => new Date());
    this.#parsers = options.parsers
      ? Promise.resolve(options.parsers)
      : Promise.all(
          registry("parsers")
            .plugins()
            .map(async (p) => (await p.load()) as Parser),
        );
    // Loading happens on first use; a failure there should surface then, not as an unhandled rejection.
    this.#parsers.catch(() => undefined);
  }

  /** The parser for a file: the one that accepts it best, if any accepts it at all. */
  async parserFor(meta: { mime_type: string; filename?: string; size_bytes: number }): Promise<Parser | undefined> {
    let best: Parser | undefined;
    let score = 0;
    for (const p of await this.#parsers) {
      const s = p.accepts(meta);
      if (s > score) [best, score] = [p, s];
    }
    return best;
  }

  async documents(sourceId: string): Promise<DocumentState[]> {
    return this.records.find(DOCUMENTS, { source_id: sourceId }, { orderBy: "key" });
  }

  /**
   * Store a version's blocks and spans and publish blocks.changed, unless that was done
   * before. Versions of one document are normalized one at a time.
   */
  async normalize(sourceVersionId: string): Promise<NormalizeResult> {
    const version = await this.store.getSourceVersion(sourceVersionId);
    if (!version) throw new RangeError(`unknown source version ${sourceVersionId}`);
    const key = documentKey(version.source_id, version.external_id);
    const before = this.#running.get(key) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.#normalize(version));
    this.#running.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(key) === run) this.#running.delete(key);
    }
  }

  readonly onDocumentFetched: EventHandler = async (event: EventEnvelope) => {
    const fetched: DocumentFetched = payloadOf(event, "document.fetched");
    await this.normalize(fetched.source_version_id);
  };

  /** The handlers to subscribe, by event type, under the consumer group "normalization". */
  handlers(): Record<string, EventHandler> {
    return { "document.fetched": this.onDocumentFetched };
  }

  async #normalize(version: SourceVersion): Promise<NormalizeResult> {
    const key = documentKey(version.source_id, version.external_id);
    const state = await this.records.get(DOCUMENTS, key);
    if (state?.source_version_id === version.id) return { status: "already_normalized" };
    const stored = await this.store.blocksOf(version.id);
    if (stored.length) {
      // The blocks and their event committed, but the state did not: finish the state only.
      const spans = await this.store.spansOf(version.id);
      const print = fingerprint(textOf(stored));
      await this.#saveState(
        version,
        state,
        { status: "parsed", blocks: stored, spans, fingerprint: print },
        { keepVersion: state !== undefined && state.fetched_at > version.fetched_at },
      );
      return { status: "already_normalized" };
    }
    // Diff against what normalization last stored for the document, so a version that failed
    // to parse does not count as the document losing all its text.
    const newer = state !== undefined && state.fetched_at > version.fetched_at;
    const baseId = newer ? version.previous_version_id : (state?.source_version_id ?? version.previous_version_id);
    const base = baseId
      ? { id: baseId, blocks: await this.store.blocksOf(baseId), spans: await this.store.spansOf(baseId) }
      : undefined;

    const result = version.deleted
      ? { status: "deleted" as const, blocks: [], spans: [] }
      : await this.#content(version, base);
    if (result.status === "failed") {
      log.warn("could not parse", { source_version_id: version.id, warnings: result.warnings });
      await this.#saveFailure(version, state, result.warnings ?? []);
      return { status: "failed" };
    }
    const diff = blockDiff(base ?? { blocks: [], spans: [] }, result);
    const payload: BlocksChanged = {
      source_id: version.source_id,
      source_version_id: version.id,
      ...(base && { previous_version_id: base.id }),
      ...diff,
    };
    if (version.deleted) payload.deleted = true;
    const print = version.deleted ? undefined : fingerprint(textOf(result.blocks));
    const duplicates = print ? await this.#duplicates(version, print) : [];
    if (duplicates.length) payload.duplicates = duplicates;
    const event = newEvent("blocks.changed", payload, {
      tenantId: version.tenant_id,
      producer: COMPONENT,
      subject: `${version.source_id}:${version.external_id}`,
      occurredAt: this.clock(),
    });
    await this.store.transaction(async (tx) => {
      // Spans that earlier versions introduced are stored already, under those versions.
      const introduced = result.spans.filter((sp) => sp.source_version_id === version.id);
      await tx.putBlocks(version.id, result.blocks, introduced);
      await tx.publish(event);
    });
    await this.#saveState(version, state, { ...result, fingerprint: print }, { keepVersion: newer });
    return { status: result.status, diff: payload };
  }

  /** The version's blocks and spans, parsed or taken from the connector's own structure. */
  async #content(
    version: SourceVersion,
    base: { id: string; blocks: SourceBlock[]; spans: Span[] } | undefined,
  ): Promise<Content> {
    if (!version.blob)
      return { status: "unsupported", blocks: [], spans: [], warnings: ["the version has no document"] };
    const doc = parseAs<NormalizedDocument>("NormalizedDocument", await this.#document(version));
    const ref = { sourceId: version.source_id, externalId: version.external_id };
    let docBlocks: DocBlock[];
    let native = true;
    let status: DocumentStatus = "structured";
    let parser: ProducerInfo | undefined;
    const warnings: string[] = [];
    if (doc.blocks?.length) docBlocks = doc.blocks;
    else if (doc.process) docBlocks = processBlocks(doc.process);
    else if (doc.file) {
      native = false;
      const meta = { mime_type: doc.file.mime_type, size_bytes: doc.file.size_bytes, filename: doc.file.filename };
      const previous = base && (await this.store.getSourceVersion(base.id));
      if (previous && previous.version.content_hash === version.version.content_hash && base?.blocks.length) {
        // Only metadata changed: the text is the same, so the blocks are too.
        return {
          status: "unchanged",
          blocks: base.blocks.map((b) => ({ ...b, source_version_id: version.id })),
          spans: base.spans,
        };
      }
      const chosen = await this.parserFor(meta);
      if (!chosen)
        return { status: "unsupported", blocks: [], spans: [], warnings: [`no parser for ${meta.mime_type}`] };
      try {
        const parsed = await chosen.parse(
          doc.file,
          meta,
          { ...(doc.language && { language: doc.language }), sensitivity: version.sensitivity },
          { blobs: this.blobs, models: this.models },
        );
        docBlocks = parseAs<{ blocks: DocBlock[] }>("ParseResult", parsed).blocks;
        parser = parsed.parser;
        warnings.push(...(parsed.warnings ?? []));
        status = "parsed";
      } catch (e) {
        return { status: "failed", blocks: [], spans: [], warnings: [String((e as Error).message ?? e)] };
      }
    } else docBlocks = [];
    const drafts = flatten(docBlocks);
    let ids = draftIds(drafts, ref, native);
    if (!native && base?.blocks.length) {
      ids = align(
        drafts.map((d, i) => ({ id: ids[i] as string, kind: d.kind, text: d.text })),
        base.blocks,
      );
    }
    const { blocks, spans } = build(drafts, ids, version);
    return { status, blocks, spans, ...(parser && { parser }), ...(warnings.length && { warnings }) };
  }

  async #document(version: SourceVersion): Promise<unknown> {
    const blob = version.blob as NonNullable<SourceVersion["blob"]>;
    if (blob.mime_type !== MIME_DOCUMENT)
      throw new RangeError(`${version.id}: blob is ${blob.mime_type}, not a document`);
    return JSON.parse(new TextDecoder().decode(await this.blobs.get(blob)));
  }

  /** Current documents of the tenant whose text equals or nearly equals this one. */
  async #duplicates(version: SourceVersion, print: Fingerprint): Promise<DuplicateDocument[]> {
    if (print.length < MIN_TEXT) return [];
    const self = documentKey(version.source_id, version.external_id);
    const rows = await this.records.find(
      FINGERPRINTS,
      { tenant_id: version.tenant_id, band: bands(print.simhash) },
      { orderBy: "key" },
    );
    const seen = new Set<string>([self]);
    const out: DuplicateDocument[] = [];
    for (const row of rows) {
      if (seen.has(row.document)) continue;
      seen.add(row.document);
      const theirs = row.fingerprint;
      const exact = theirs.text_hash === print.text_hash;
      const distance = hamming(theirs.simhash, print.simhash);
      const comparable = Math.min(theirs.length, print.length) >= MIN_NEAR_TEXT;
      if (!exact && (!comparable || distance > NEAR)) continue;
      out.push({
        source_id: row.source_id,
        external_id: row.external_id,
        source_version_id: row.source_version_id,
        exact,
        similarity: exact ? 1 : Math.round((1 - distance / 64) * 1000) / 1000,
      });
    }
    return out.sort((a, b) => Number(b.exact) - Number(a.exact) || b.similarity - a.similarity);
  }

  /** A failed parse keeps the last good version as the diff base and notes the failure. */
  async #saveFailure(version: SourceVersion, state: DocumentState | undefined, warnings: string[]): Promise<void> {
    const at = this.clock().toISOString();
    if (state) {
      if (state.fetched_at > version.fetched_at) return;
      await this.records.transaction((tx) =>
        tx.put(DOCUMENTS, [{ ...state, failed: { source_version_id: version.id, warnings, at } }]),
      );
      return;
    }
    await this.#saveState(version, undefined, { status: "failed", blocks: [], spans: [], warnings });
  }

  async #saveState(
    version: SourceVersion,
    state: DocumentState | undefined,
    result: Content & { fingerprint?: Fingerprint | undefined },
    options: { keepVersion?: boolean } = {},
  ): Promise<void> {
    if (options.keepVersion && state) return;
    const document = documentKey(version.source_id, version.external_id);
    const next: DocumentState = {
      tenant_id: version.tenant_id,
      source_id: version.source_id,
      external_id: version.external_id,
      source_version_id: version.id,
      fetched_at: version.fetched_at,
      status: result.status,
      block_count: result.blocks.length,
      span_count: result.blocks.reduce((n, b) => n + b.span_ids.length, 0),
      normalized_at: this.clock().toISOString(),
    };
    if (result.parser) next.parser = result.parser;
    else if (result.status === "unchanged" && state?.parser) next.parser = state.parser;
    if (result.warnings?.length) next.warnings = result.warnings;
    const print = result.fingerprint ?? (result.status === "unchanged" ? state?.fingerprint : undefined);
    if (print && print.length >= MIN_TEXT) next.fingerprint = print;
    const oldBands = state?.fingerprint ? bands(state.fingerprint.simhash) : [];
    const newBands = next.fingerprint ? bands(next.fingerprint.simhash) : [];
    await this.records.transaction(async (tx) => {
      await tx.put(DOCUMENTS, [next]);
      const gone = oldBands.filter((b) => !newBands.includes(b)).map((b) => `${b}\x1f${document}`);
      if (gone.length) await tx.delete(FINGERPRINTS, gone);
      if (!next.fingerprint) return;
      const { source_id, external_id, source_version_id, fingerprint } = next;
      await tx.put(
        FINGERPRINTS,
        newBands.map((band) => ({
          tenant_id: version.tenant_id,
          band,
          document,
          source_id,
          external_id,
          source_version_id,
          fingerprint,
        })),
      );
    });
  }
}

/** A version's text, each table once: a table block repeats its rows' text. */
function textOf(blocks: readonly SourceBlock[]): string {
  return blocks
    .filter((b) => b.kind !== "table")
    .map((b) => b.text)
    .join("\n");
}

interface Content {
  status: DocumentStatus;
  blocks: SourceBlock[];
  spans: Span[];
  parser?: ProducerInfo;
  warnings?: string[];
}

/**
 * An approval definition as blocks: its form fields and its nodes in order, anchored by
 * their keys. Instances stay in the document for SOP mining; they are records, not text.
 */
export function processBlocks(process: ProcessSnapshot): DocBlock[] {
  const def = process.definition;
  if (!def) return [];
  const blocks: DocBlock[] = [{ anchor: `definition:${def.code}`, kind: "heading", level: 1, text: def.name }];
  for (const f of def.form_fields ?? []) {
    const options = f.options?.length ? `: ${f.options.join(" / ")}` : "";
    blocks.push({
      anchor: `field:${f.key}`,
      kind: "form_field",
      field_key: f.key,
      text: `${f.label}${options}`,
      attrs: { ...(f.field_type && { field_type: f.field_type }), ...(f.required && { required: true }) },
    });
  }
  def.nodes.forEach((n, i) => {
    blocks.push({
      anchor: `node:${n.key}`,
      kind: "list_item",
      level: 0,
      text: n.name,
      attrs: { ordered: true, step: i + 1, node_type: n.node_type },
    });
  });
  return blocks;
}
