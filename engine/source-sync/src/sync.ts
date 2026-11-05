import {
  type AclEntry,
  type AclSnapshot,
  type BlobStore,
  type ChangeVia,
  type Connector,
  type ConnectorFactory,
  contentHash,
  contractErrors,
  type DocumentEntry,
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  type NormalizedDocument,
  newEvent,
  newId,
  payloadOf,
  type Source,
  type SourceRef,
  type SourceVersion,
  sameVersion,
  type Version,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { logger, registry } from "@inspiration/kernel";
import { entryOf } from "./tree.ts";
import { recordOf, UPLOAD_TYPE, UPLOADS, type Upload, uploadArea, uploadAreaId, uploadConnector } from "./uploads.ts";

const log = logger("source-sync");

export const COMPONENT = "source-sync";

/** What source sync last stored for an item. */
export interface ItemState {
  source_id: string;
  external_id: string;
  /** The connector's hashes of the stored version. */
  version: Version;
  source_version_id: string;
  title?: string;
  seen_at: string;
  deleted: boolean;
}

export const SOURCES = defineTable<Source>("sync.sources", {
  key: (s) => s.id,
  columns: { tenant_id: (s) => s.tenant_id, status: (s) => s.status },
});

export const ITEMS = defineTable<ItemState>("sync.items", {
  key: (i) => itemKey(i.source_id, i.external_id),
  columns: { source_id: (i) => i.source_id, deleted: (i) => i.deleted },
  types: { deleted: "boolean" },
});

export function itemKey(sourceId: string, externalId: string): string {
  return `${sourceId}\x1f${externalId}`;
}

/**
 * Maps a source's own principal (a Feishu open_id, a folder ACL's group name) to an engine
 * principal ID. The business layer's directory owns these links; unmapped principals stay
 * without principal_id, and access control denies them.
 */
export type PrincipalResolver = (source: Source, entry: AclEntry) => string | undefined;

/** A document with its latest stored version, as the Documents tree lists it. */
export interface ListedDocument {
  version: SourceVersion;
  entry: DocumentEntry;
}

export type ItemOutcome = "created" | "updated" | "acl_changed" | "unchanged" | "deleted" | "failed";

export interface SyncReport {
  source_id: string;
  listed: number;
  outcomes: Record<ItemOutcome, number>;
  errors: { external_id: string; error: string }[];
}

export interface SourceSyncOptions {
  store: KnowledgeStore;
  records: Records;
  blobs: BlobStore;
  resolvePrincipal?: PrincipalResolver;
  /** Connector factories by source type; defaults to the "connectors" plugins. */
  connector?: (type: string) => Promise<ConnectorFactory>;
  secret?: (name: string) => Promise<string>;
  clock?: () => Date;
}

const DEFAULT_SENSITIVITY = "internal";
const DEFAULT_AUTHORITY = 0.5;
/** Uploads, web pages and anything nobody classified: searchable and citable, never owned. */
const DEFAULT_LEVEL = "reference";
/** Inline snapshots up to this many entries in acl.changed; larger ones are read from the store. */
const INLINE_ACL_ENTRIES = 50;

/**
 * Keeps the knowledge store in step with every connected source. See the package docs.
 */
export class SourceSync {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly clock: () => Date;
  readonly #resolve: PrincipalResolver;
  readonly #connectorFactory: (type: string) => Promise<ConnectorFactory>;
  readonly #secret: (name: string) => Promise<string>;
  readonly #connectors = new Map<string, Connector>();
  /** One sync per source at a time; item fetches of one source are serialized behind it. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: SourceSyncOptions) {
    this.store = options.store;
    this.records = options.records;
    this.blobs = options.blobs;
    this.clock = options.clock ?? (() => new Date());
    this.#resolve = options.resolvePrincipal ?? (() => undefined);
    this.#connectorFactory = options.connector ?? ((type) => registry("connectors").get<ConnectorFactory>(type));
    this.#secret =
      options.secret ??
      (async (name) => {
        throw new RangeError(`no secret store configured (asked for ${name})`);
      });
  }

  // ------------------------------------------------------------ sources

  /** Register or update a source. The caller has registered its space with access control. */
  async addSource(source: Source): Promise<void> {
    const errors = contractErrors("Source", source);
    if (errors.length) throw new RangeError(`invalid source: ${errors.join("; ")}`);
    await this.records.transaction((tx) => tx.put(SOURCES, [source]));
    this.#connectors.delete(source.id);
  }

  getSource(sourceId: string): Promise<Source | undefined> {
    return this.records.get(SOURCES, sourceId);
  }

  listSources(tenantId?: string): Promise<Source[]> {
    return this.records.find(SOURCES, tenantId ? { tenant_id: tenantId } : {});
  }

  items(sourceId: string): Promise<ItemState[]> {
    return this.records.find(ITEMS, { source_id: sourceId });
  }

  /**
   * The documents of a space's sources, each with its latest stored version, for the
   * Documents tree (documentTree). Deleted items are left out. The caller keeps only those a
   * reader may open before it builds the tree.
   */
  async documents(tenantId: string, spaceId: string): Promise<{ sources: Source[]; documents: ListedDocument[] }> {
    const sources = (await this.listSources(tenantId)).filter((s) => s.space_id === spaceId);
    const documents: ListedDocument[] = [];
    for (const source of sources) {
      const items = (await this.items(source.id)).filter((i) => !i.deleted);
      const versions = await Promise.all(items.map((i) => this.store.getSourceVersion(i.source_version_id)));
      for (const version of versions) if (version) documents.push({ version, entry: entryOf(version) });
    }
    return { sources, documents };
  }

  /** One document's latest stored version, or undefined when the item is unknown or deleted. */
  async document(sourceId: string, externalId: string): Promise<ListedDocument | undefined> {
    const state = await this.records.get(ITEMS, itemKey(sourceId, externalId));
    if (!state || state.deleted) return undefined;
    const version = await this.store.getSourceVersion(state.source_version_id);
    return version && { version, entry: entryOf(version) };
  }

  async #source(sourceId: string): Promise<Source> {
    const source = await this.getSource(sourceId);
    if (!source) throw new RangeError(`unknown source ${sourceId}`);
    return source;
  }

  async #connector(source: Source): Promise<Connector> {
    let c = this.#connectors.get(source.id);
    if (!c) {
      // An upload area's system is source sync's own record of the files.
      if (source.type === UPLOAD_TYPE) c = uploadConnector(this.records, source);
      else c = (await this.#connectorFactory(source.type))(source, { blobs: this.blobs, secret: this.#secret });
      this.#connectors.set(source.id, c);
    }
    return c;
  }

  #serialized<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#running.get(sourceId) ?? Promise.resolve()).then(fn);
    this.#running.set(
      sourceId,
      run.catch(() => undefined),
    );
    return run;
  }

  // ------------------------------------------------------------ uploads

  /** A space's upload area, created with its first file. The caller registers it with access control. */
  async uploadArea(tenantId: string, spaceId: string): Promise<Source> {
    const existing = await this.getSource(uploadAreaId(spaceId));
    if (existing) {
      if (existing.tenant_id !== tenantId) throw new RangeError(`space ${spaceId} is in another tenant`);
      return existing;
    }
    const area = uploadArea(tenantId, spaceId, this.#now());
    await this.addSource(area);
    return area;
  }

  /**
   * Put a file into an upload area and store it as the item at its path: a new document, or
   * a new version of the one there. The same bytes at the same path change nothing. Uploads to
   * an area take turns within this process; two processes writing one area could each confirm
   * the other's file, so the engine runs one writing process for now.
   */
  upload(sourceId: string, file: Upload): Promise<{ document: DocumentEntry; changed: boolean }> {
    return this.#serialized(sourceId, async () => {
      const source = await this.#source(sourceId);
      if (source.type !== UPLOAD_TYPE) throw new RangeError(`${sourceId} is not an upload area`);
      const record = await recordOf(this.records, this.blobs, sourceId, file, this.#now());
      if (record) await this.records.transaction((tx) => tx.put(UPLOADS, [record]));
      const ref = { source_id: sourceId, external_id: file.path };
      const state = await this.records.get(ITEMS, itemKey(sourceId, file.path));
      let changed = false;
      // The item holds these bytes once they are stored. An upload that failed after its record
      // was written leaves the item on older bytes, and the retry stores them.
      const stored = state && !state.deleted && state.version.content_hash === contentHash(file.bytes);
      if (!stored) {
        const { outcome, error } = await this.#fetchItem(source, await this.#connector(source), ref, state, "manual");
        if (error) throw new Error(error);
        changed = outcome !== "unchanged";
      }
      const listed = await this.document(sourceId, file.path);
      if (!listed) throw new Error(`upload ${file.path} was not stored`);
      return { document: listed.entry, changed };
    });
  }

  // ------------------------------------------------------------ syncing

  /**
   * List the whole source and bring every item up to date: fetch what is new or changed,
   * and write tombstones for items that are gone.
   */
  sync(sourceId: string, options: { via?: ChangeVia } = {}): Promise<SyncReport> {
    return this.#serialized(sourceId, async () => {
      const source = await this.#source(sourceId);
      const connector = await this.#connector(source);
      const report: SyncReport = {
        source_id: sourceId,
        listed: 0,
        outcomes: { created: 0, updated: 0, acl_changed: 0, unchanged: 0, deleted: 0, failed: 0 },
        errors: [],
      };
      const known = new Map((await this.items(sourceId)).map((i) => [i.external_id, i]));
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await connector.list(source.scope, cursor);
        for (const item of page.items) {
          report.listed++;
          seen.add(item.ref.external_id);
          const state = known.get(item.ref.external_id);
          if (state && !state.deleted && sameVersion(state.version, item.version)) {
            report.outcomes.unchanged++;
            continue;
          }
          const outcome = await this.#fetchItem(source, connector, item.ref, state, options.via ?? "poll");
          report.outcomes[outcome.outcome]++;
          if (outcome.error) report.errors.push({ external_id: item.ref.external_id, error: outcome.error });
        }
        cursor = page.next_cursor;
      } while (cursor);
      for (const state of known.values()) {
        if (state.deleted || seen.has(state.external_id)) continue;
        await this.#tombstone(source, state);
        report.outcomes.deleted++;
      }
      log.info("synced source", { source: sourceId, ...report.outcomes });
      return report;
    });
  }

  /** Bring one item up to date, as a webhook or a manual refresh asks. */
  syncItem(
    sourceId: string,
    ref: SourceRef,
    options: { via?: ChangeVia; deleted?: boolean } = {},
  ): Promise<ItemOutcome> {
    return this.#serialized(sourceId, async () => {
      const source = await this.#source(sourceId);
      const state = await this.records.get(ITEMS, itemKey(sourceId, ref.external_id));
      if (options.deleted) {
        if (!state || state.deleted) return "unchanged";
        await this.#tombstone(source, state);
        return "deleted";
      }
      const connector = await this.#connector(source);
      const { outcome, error } = await this.#fetchItem(source, connector, ref, state, options.via ?? "manual");
      if (error) throw new Error(error);
      return outcome;
    });
  }

  async #fetchItem(
    source: Source,
    connector: Connector,
    ref: SourceRef,
    state: ItemState | undefined,
    via: ChangeVia,
  ): Promise<{ outcome: ItemOutcome; error?: string }> {
    let fetched: Awaited<ReturnType<Connector["fetch"]>>;
    try {
      fetched = await connector.fetch(ref, state?.deleted ? undefined : state?.version);
    } catch (e) {
      // One unreadable item must not stop the sync of the others.
      log.warn("fetch failed", { source: source.id, item: ref.external_id, error: e });
      return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    if ("unchanged" in fetched) {
      if (state) await this.records.transaction((tx) => tx.put(ITEMS, [{ ...state, seen_at: this.#now() }]));
      return { outcome: "unchanged" };
    }
    const errors = contractErrors("NormalizedDocument", fetched);
    if (errors.length) return { outcome: "failed", error: `connector returned an invalid document: ${errors[0]}` };
    return { outcome: await this.#store(source, fetched, state, via) };
  }

  #now(): string {
    return this.clock().toISOString();
  }

  /** Engine principals for the snapshot's entries; entries that stay unmapped are kept as they are. */
  #mapped(source: Source, snapshot: AclSnapshot): AclSnapshot {
    const entries = snapshot.entries.map((e) => {
      if (e.principal_id || !e.external_id) return e;
      const principal = this.#resolve(source, e);
      return principal ? { ...e, principal_id: principal } : e;
    });
    return { ...snapshot, entries };
  }

  async #store(
    source: Source,
    doc: NormalizedDocument,
    state: ItemState | undefined,
    via: ChangeVia,
  ): Promise<ItemOutcome> {
    const externalId = doc.ref.external_id;
    const previous = state?.deleted ? undefined : state;
    const contentChanged =
      !previous ||
      previous.version.content_hash !== doc.version.content_hash ||
      previous.version.metadata_hash !== doc.version.metadata_hash;
    const aclChanged = !previous || previous.version.acl_hash !== doc.version.acl_hash;
    if (!contentChanged && !aclChanged) {
      await this.records.transaction((tx) => tx.put(ITEMS, [{ ...previous, seen_at: this.#now() }]));
      return "unchanged";
    }
    const now = this.clock();
    const options = { tenantId: source.tenant_id, producer: COMPONENT, subject: `${source.id}:${externalId}` };
    let versionId = previous?.source_version_id as string;
    const events: EventEnvelope[] = [];
    let version: SourceVersion | undefined;
    if (contentChanged) {
      const { acl: _acl, ...stored } = doc;
      const blob = await this.blobs.put(new TextEncoder().encode(JSON.stringify(stored)), {
        mimeType: "application/vnd.inspiration.document+json",
      });
      version = {
        id: newId("source_version"),
        tenant_id: source.tenant_id,
        source_id: source.id,
        space_id: source.space_id,
        external_id: externalId,
        version: doc.version,
        title: doc.title,
        mime_type: doc.mime_type,
        approval_state: doc.approval_state ?? "unknown",
        authority: doc.authority ?? source.default_authority ?? DEFAULT_AUTHORITY,
        sensitivity: doc.sensitivity ?? source.default_sensitivity ?? DEFAULT_SENSITIVITY,
        governance_level: doc.governance_level ?? source.governance_level ?? DEFAULT_LEVEL,
        fetched_at: now.toISOString(),
        blob,
      };
      if (doc.ref.kind) version.kind = doc.ref.kind;
      if (doc.language) version.language = doc.language;
      if (doc.ref.uri) version.uri = doc.ref.uri;
      if (doc.metadata) version.metadata = doc.metadata;
      if (previous) version.previous_version_id = previous.source_version_id;
      versionId = version.id;
      events.push(
        newEvent(
          "document.fetched",
          {
            source_id: source.id,
            source_version_id: version.id,
            ...(previous && { previous_version_id: previous.source_version_id }),
            external_id: externalId,
            changed: {
              content: !previous || previous.version.content_hash !== doc.version.content_hash,
              metadata: !previous || previous.version.metadata_hash !== doc.version.metadata_hash,
              acl: aclChanged,
            },
            deleted: false,
            needs_parsing: Boolean(doc.file) && !doc.blocks?.length,
          },
          { ...options, occurredAt: now },
        ),
      );
    }
    const snapshot = doc.acl ? this.#mapped(source, doc.acl) : undefined;
    if (aclChanged && snapshot) {
      events.push(
        newEvent(
          "acl.changed",
          {
            source_id: source.id,
            external_id: externalId,
            space_id: source.space_id,
            source_version_id: versionId,
            acl_hash: snapshot.acl_hash,
            fidelity: snapshot.fidelity,
            ...(snapshot.entries.length <= INLINE_ACL_ENTRIES && { snapshot }),
          },
          { ...options, occurredAt: now },
        ),
      );
    }
    await this.store.transaction(async (tx) => {
      if (version) await tx.putSourceVersion(version);
      if (snapshot) await tx.putAclSnapshot(snapshot);
      await tx.publish(...events);
    });
    const next: ItemState = {
      source_id: source.id,
      external_id: externalId,
      version: doc.version,
      source_version_id: versionId,
      title: doc.title,
      seen_at: now.toISOString(),
      deleted: false,
    };
    await this.records.transaction((tx) => tx.put(ITEMS, [next]));
    log.debug("stored item", { source: source.id, item: externalId, via, version: versionId });
    if (!previous) return "created";
    return contentChanged ? "updated" : "acl_changed";
  }

  /** A tombstone version for an item that is gone from its source. */
  async #tombstone(source: Source, state: ItemState): Promise<void> {
    const last = await this.store.getSourceVersion(state.source_version_id);
    if (!last) throw new RangeError(`item ${state.external_id} names unknown version ${state.source_version_id}`);
    const now = this.clock();
    const { blob: _blob, ...rest } = last;
    const tombstone: SourceVersion = {
      ...rest,
      id: newId("source_version"),
      fetched_at: now.toISOString(),
      previous_version_id: last.id,
      deleted: true,
    };
    await this.store.transaction(async (tx) => {
      await tx.putSourceVersion(tombstone);
      await tx.publish(
        newEvent(
          "document.fetched",
          {
            source_id: source.id,
            source_version_id: tombstone.id,
            previous_version_id: last.id,
            external_id: state.external_id,
            changed: { content: true, metadata: false, acl: false },
            deleted: true,
          },
          {
            tenantId: source.tenant_id,
            producer: COMPONENT,
            subject: `${source.id}:${state.external_id}`,
            occurredAt: now,
          },
        ),
      );
    });
    await this.records.transaction((tx) =>
      tx.put(ITEMS, [{ ...state, source_version_id: tombstone.id, seen_at: now.toISOString(), deleted: true }]),
    );
  }

  // ------------------------------------------------------------ events

  /** source.changed: sync the one item it names. */
  readonly onSourceChanged: EventHandler = async (event) => {
    const { source_id, change } = payloadOf(event, "source.changed");
    if (!(await this.getSource(source_id))) {
      log.warn("source.changed for an unknown source", { source: source_id });
      return;
    }
    await this.syncItem(source_id, change.ref, { via: change.via, deleted: change.kind === "deleted" });
  };

  /** The handlers to subscribe, by event type, under the consumer group "source-sync". */
  handlers(): Record<string, EventHandler> {
    return { "source.changed": this.onSourceChanged };
  }
}
