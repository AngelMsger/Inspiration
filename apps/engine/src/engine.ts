import { join } from "node:path";
import { Inbox } from "@inspiration/collaboration";
import type {
  BlobStore,
  EventEnvelope,
  EventHandler,
  EventPublisher,
  KnowledgeStore,
  ModelGateway,
  ReviewDue,
} from "@inspiration/contracts";
import {
  Consumer,
  InMemoryTransport,
  MemoryRecords,
  OutboxRelay,
  PgRecords,
  type Records,
  type Transport,
  ValkeyStreamsTransport,
} from "@inspiration/eventbus";
import { Extraction, type ExtractionOptions } from "@inspiration/extraction";
import { Freshness } from "@inspiration/freshness";
import { Governance, type GovernanceResult } from "@inspiration/governance";
import { applyMigrations, LocalBlobStore, logger, openPool, type Pool, workspaceRoot } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { Gateway, loadGatewayConfig } from "@inspiration/model-gateway";
import { Normalization } from "@inspiration/normalization";
import { Topics } from "@inspiration/page-compiler";
import { type PrincipalResolver, SourceSync } from "@inspiration/source-sync";

const log = logger("engine");

export interface EngineOptions {
  /** Postgres URL. Without one the engine keeps everything in memory, which suits small corpora only. */
  databaseUrl?: string;
  /** Valkey URL for the event transport. Without one, events go from the outbox to consumers in this process. */
  valkeyUrl?: string;
  /** Prefix of the Valkey stream keys, so runs can share one Valkey. */
  streamPrefix?: string;
  blobDir: string;
  /** Maps source principals to engine principals; the business layer's directory. */
  resolvePrincipal?: PrincipalResolver;
  /** Defaults to the development gateway (config/gateway.dev.yaml): fake providers only. */
  models?: ModelGateway;
  /** Each tenant's predicate catalogue for extraction; the business layer will provide it. */
  vocabulary?: ExtractionOptions["vocabulary"];
  /** What governance and freshness take as now; simulated runs move it a day at a time. */
  clock?: () => Date;
}

/** A component as the engine runs it: event handlers by type, under the component's consumer group. */
interface Running {
  readonly group: string;
  handlers(): Record<string, EventHandler>;
}

/**
 * The engine process: one store, one blob store, one event bus, and the built components
 * subscribed under their own consumer groups. Long-running deployments call run(); batch
 * runs (ingest a corpus, then report) call settle() to deliver until nothing is left.
 */
export class Engine {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly models: ModelGateway;
  readonly sync: SourceSync;
  readonly normalization: Normalization;
  readonly extraction: Extraction;
  readonly governance: Governance;
  readonly freshness: Freshness;
  readonly topics: Topics;
  readonly inbox: Inbox;
  readonly consumer: Consumer;
  readonly transport: Transport;
  readonly #relay: OutboxRelay | undefined;
  readonly #pool: Pool | undefined;
  readonly #closers: (() => Promise<unknown>)[] = [];

  private constructor(parts: {
    store: KnowledgeStore;
    records: Records;
    blobs: BlobStore;
    models: ModelGateway;
    transport: Transport;
    relay?: OutboxRelay;
    pool?: Pool;
    resolvePrincipal?: PrincipalResolver;
    vocabulary?: ExtractionOptions["vocabulary"];
    clock?: () => Date;
  }) {
    this.store = parts.store;
    this.records = parts.records;
    this.blobs = parts.blobs;
    this.models = parts.models;
    this.transport = parts.transport;
    this.#relay = parts.relay;
    this.#pool = parts.pool;
    // Batch runs retry a failed delivery at once instead of after a visibility timeout.
    this.consumer = new Consumer(parts.transport, { name: "engine", visibilityTimeoutMs: 0, maxDeliveries: 3 });
    this.sync = new SourceSync({
      store: this.store,
      records: this.records,
      blobs: this.blobs,
      ...(parts.resolvePrincipal && { resolvePrincipal: parts.resolvePrincipal }),
    });
    this.normalization = new Normalization({
      store: this.store,
      records: this.records,
      blobs: this.blobs,
      models: this.models,
    });
    this.extraction = new Extraction({
      store: this.store,
      records: this.records,
      models: this.models,
      ...(parts.vocabulary && { vocabulary: parts.vocabulary }),
    });
    const clock = parts.clock && { clock: parts.clock };
    this.governance = new Governance({ store: this.store, records: this.records, ...clock });
    this.freshness = new Freshness({ store: this.store, records: this.records, ...clock });
    this.topics = new Topics({ store: this.store, records: this.records, models: this.models, ...clock });
    this.inbox = new Inbox({ store: this.store, records: this.records, ...clock });
    const components: Running[] = [
      { group: "source-sync", handlers: () => this.sync.handlers() },
      { group: "normalization", handlers: () => this.normalization.handlers() },
      { group: "extraction", handlers: () => this.extraction.handlers() },
      { group: "governance", handlers: () => this.governance.handlers() },
      { group: "freshness", handlers: () => this.freshness.handlers() },
      { group: "page-compiler", handlers: () => this.topics.handlers() },
      { group: "collaboration", handlers: () => this.inbox.handlers() },
    ];
    for (const c of components) {
      for (const [type, handler] of Object.entries(c.handlers())) this.consumer.subscribe(type, c.group, handler);
    }
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const blobs = new LocalBlobStore(options.blobDir);
    const closers: (() => Promise<unknown>)[] = [];
    let models = options.models;
    if (!models) {
      const gateway = await Gateway.create(loadGatewayConfig(join(workspaceRoot(), "config", "gateway.dev.yaml")));
      closers.push(() => gateway.close());
      models = gateway;
    }
    let transport: Transport;
    if (options.valkeyUrl) {
      transport = ValkeyStreamsTransport.fromUrl(
        options.valkeyUrl,
        options.streamPrefix ? { prefix: options.streamPrefix } : {},
      );
    } else transport = new InMemoryTransport();
    closers.push(() => transport.close());
    const resolve = {
      ...(options.resolvePrincipal && { resolvePrincipal: options.resolvePrincipal }),
      ...(options.vocabulary && { vocabulary: options.vocabulary }),
      ...(options.clock && { clock: options.clock }),
    };

    let engine: Engine;
    if (options.databaseUrl) {
      await applyMigrations(options.databaseUrl);
      const pool = await openPool(options.databaseUrl);
      closers.push(() => pool.end());
      engine = new Engine({
        store: new PostgresStore(pool),
        records: new PgRecords(pool),
        blobs,
        models,
        transport,
        relay: new OutboxRelay(options.databaseUrl, transport),
        pool,
        ...resolve,
      });
    } else {
      const publisher: EventPublisher = { publish: (...events: EventEnvelope[]) => transport.send(events) };
      engine = new Engine({
        store: new MemoryStore({ publisher }),
        records: new MemoryRecords({ publisher }),
        blobs,
        models,
        transport,
        ...resolve,
      });
    }
    engine.#closers.push(...closers.reverse());
    return engine;
  }

  /**
   * The engine's daily work for a tenant: freshness publishes the reviews that fell due, and
   * governance decides again the slots in which a dated change took effect. Then every
   * event is delivered.
   */
  async tick(tenantId: string): Promise<{ reviews: ReviewDue[]; rechecked: GovernanceResult }> {
    const reviews = await this.freshness.tick(tenantId);
    const rechecked = await this.governance.recheck(tenantId);
    await this.settle();
    return { reviews, rechecked };
  }

  /** Subscribe an extra handler, for reports and tests that watch the events go by. */
  observe(eventType: string, group: string, handler: EventHandler): void {
    this.consumer.subscribe(eventType, group, handler);
  }

  /**
   * Relay the outbox and deliver to every consumer group until a full round moves nothing.
   * Returns the number of deliveries.
   */
  async settle(maxRounds = 10_000): Promise<number> {
    const client = this.#pool ? await this.#pool.connect() : undefined;
    try {
      let total = 0;
      for (let round = 0; round < maxRounds; round++) {
        let moved = client && this.#relay ? await this.#relay.drain(client) : 0;
        for (const group of this.consumer.groups()) {
          const n = await this.consumer.runOnce(group);
          moved += n;
          total += n;
        }
        if (moved === 0) return total;
      }
      throw new Error(`events still flowing after ${maxRounds} rounds; possible loop`);
    } finally {
      client?.release();
    }
  }

  async close(): Promise<void> {
    for (const close of this.#closers) {
      await close().catch((error: unknown) => log.warn("close failed", { error }));
    }
  }
}
