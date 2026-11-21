import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AuthzService, Directory, type Graph, MemoryGraph } from "@inspiration/access-control";
import { Assistant, DocumentComments, Inbox } from "@inspiration/collaboration";
import type {
  BlobStore,
  Citation,
  EventEnvelope,
  EventHandler,
  EventPublisher,
  KeywordIndex,
  KnowledgeStore,
  ModelGateway,
  Principal,
  ReviewDue,
  VectorIndex,
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
import {
  applyMigrations,
  LocalBlobStore,
  logger,
  type MigrationSet,
  openPool,
  type Pool,
  registry,
  workspaceRoot,
} from "@inspiration/kernel";
import {
  MemoryKeywordIndex,
  MemoryStore,
  MemoryVectorIndex,
  PgSearchIndex,
  PgVectorIndex,
  PostgresStore,
} from "@inspiration/knowledge-store";
import { Gateway, loadGatewayConfig } from "@inspiration/model-gateway";
import { Normalization } from "@inspiration/normalization";
import { Topics } from "@inspiration/page-compiler";
import { type AnswerSources, COMPACT_SOURCES, Retrieval } from "@inspiration/retrieval";
import { type PrincipalResolver, SourceSync } from "@inspiration/source-sync";

import { readForAnswer } from "./reading-on-use.ts";

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
  secret?: (name: string) => Promise<string>;
  discoverFacts?: boolean;
  /** Read authorized reference passages before answering, independently of catalogue discovery. */
  readOnUse?: boolean;
  /** Defaults to the development gateway (config/gateway.dev.yaml): fake providers only. */
  models?: ModelGateway;
  /**
   * The gateway whose ledger and budgets the usage page reads (Models.ledger); the development
   * gateway when models is not given. Without one, the engine keeps no usage to show.
   */
  ledger?: Gateway;
  /** Each tenant's predicate catalogue for extraction; the business layer will provide it. */
  vocabulary?: ExtractionOptions["vocabulary"];
  /** What governance and freshness take as now; simulated runs move it a day at a time. */
  clock?: () => Date;
  /** The permission graph; in memory unless given (a SpiceDBGraph in a deployment). */
  graph?: Graph;
  /** How many passages and statements a compact answer reads (Engine.compact); COMPACT_SOURCES unless given. */
  compactSources?: AnswerSources;
  /**
   * How events are delivered. "batch" (default) retries failed deliveries at once
   * (visibilityTimeoutMs: 0) for synchronous settle() runs; "service" uses a non-zero
   * visibility timeout (SERVER_VISIBILITY_TIMEOUT_MS) and a per-process consumer name so
   * multiple engine replicas share the bus safely.
   */
  deliveryMode?: DeliveryMode;
}

/** Synchronous batch draining ("batch") or continuous multi-replica workers ("service"). */
export type DeliveryMode = "batch" | "service";

/** How long a delivery stays unacked in service mode before another replica may reclaim it. */
export const SERVER_VISIBILITY_TIMEOUT_MS = 60_000;

/** How often a long-running engine reads on where reading stopped (Engine.resumeReading). */
export const RESUME_EVERY_MS = 15 * 60_000;

/** Migration plugins owned by the engine and its libraries, excluding business-layer schemas. */
const ENGINE_MIGRATIONS = [
  "bus",
  "kb",
  "gateway",
  "authz",
  "sync",
  "normalization",
  "extraction",
  "freshness",
  "governance",
  "page-compiler",
  "collaboration",
  "retrieval",
  "agents",
] as const;

/** The migration sets the engine applies to its own database. */
export async function engineMigrations(): Promise<MigrationSet[]> {
  const migrations = registry("migrations");
  return Promise.all(ENGINE_MIGRATIONS.map((name) => migrations.get<MigrationSet>(name)));
}

/** A component as the engine runs it: event handlers by type, under the component's consumer group. */
interface Running {
  readonly group: string;
  handlers(): Record<string, EventHandler>;
}

/**
 * The engine process: one store, one blob store, one event bus, and the built components
 * subscribed under their own consumer groups. Batch runs (ingest a corpus, then report) and
 * single-process in-memory servers deliver with settle() and settleLater(); persistent
 * multi-replica deployments open with deliveryMode: "service" and call startDelivery() to run
 * the outbox relay (under Postgres RELAY_LOCK) and consumer groups continuously in the background.
 */
export class Engine {
  readonly deliveryMode: DeliveryMode;
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly models: ModelGateway;
  /** The gateway's ledger and budgets, for usage; absent when the engine was not given one. */
  readonly ledger: Gateway | undefined;
  /** What the engine takes as now. */
  readonly clock: () => Date;
  readonly sync: SourceSync;
  readonly normalization: Normalization;
  readonly extraction: Extraction;
  readonly governance: Governance;
  readonly freshness: Freshness;
  readonly topics: Topics;
  readonly inbox: Inbox;
  readonly comments: DocumentComments;
  /** Decide for me: the assistant's decisions on members' todos, and their standing delegations. */
  readonly assistant: Assistant;
  readonly authz: AuthzService;
  /** The copy of the business layer's tenants and members, and the spaces, granted in the same graph as authz reads. */
  readonly directory: Directory;
  /** Each tenant's predicate catalogue, as extraction reads it; the inbox names facts by it. */
  readonly vocabulary: NonNullable<ExtractionOptions["vocabulary"]>;
  /** Search, and the standard answer: as many passages as statements. */
  readonly retrieval: Retrieval;
  /** The vector and keyword search indexes shared across retrieval paths. */
  readonly vectors: VectorIndex;
  readonly keywords: KeywordIndex;
  /**
   * The knowledge base answering from fewer sources: mostly statements, the conclusions
   * governance kept, and a few passages, a short input that a smaller model answers fast. The
   * answer a member gets unless they ask for the standard one (AnswerQuery.depth).
   */
  readonly compact: Retrieval;
  readonly consumer: Consumer;
  readonly transport: Transport;
  readonly #relay: OutboxRelay | undefined;
  readonly #pool: Pool | undefined;
  readonly #reading = new Set<Promise<number>>();
  #closing = false;
  readonly #closers: (() => Promise<unknown>)[] = [];
  /** Deliveries run one at a time: two at once could hand both the same event. */
  #delivering: Promise<unknown> = Promise.resolve();
  /** Whether a background delivery waits to start; one waiting covers every later ask. */
  #queued = false;
  /** Running OutboxRelay.run() and Consumer.run() promises while continuous delivery is active. */
  #workers: Promise<unknown>[] | undefined;

  private constructor(parts: {
    store: KnowledgeStore;
    records: Records;
    blobs: BlobStore;
    models: ModelGateway;
    ledger?: Gateway;
    transport: Transport;
    relay?: OutboxRelay;
    pool?: Pool;
    resolvePrincipal?: PrincipalResolver;
    secret?: (name: string) => Promise<string>;
    discoverFacts?: boolean;
    readOnUse?: boolean;
    vocabulary?: ExtractionOptions["vocabulary"];
    clock?: () => Date;
    graph?: Graph;
    compactSources?: AnswerSources;
    deliveryMode?: DeliveryMode;
  }) {
    this.deliveryMode = parts.deliveryMode ?? "batch";
    this.store = parts.store;
    this.records = parts.records;
    this.blobs = parts.blobs;
    this.models = parts.models;
    this.ledger = parts.ledger;
    this.clock = parts.clock ?? (() => new Date());
    this.transport = parts.transport;
    this.#relay = parts.relay;
    this.#pool = parts.pool;
    // Batch runs retry a failed delivery at once; multi-replica servers keep a visibility
    // timeout and a per-process consumer name so peer replicas never steal in-flight work.
    this.consumer =
      this.deliveryMode === "service"
        ? new Consumer(parts.transport, {
            visibilityTimeoutMs: SERVER_VISIBILITY_TIMEOUT_MS,
            maxDeliveries: 3,
            ordered: true,
          })
        : new Consumer(parts.transport, { name: "engine", visibilityTimeoutMs: 0, maxDeliveries: 3 });
    this.sync = new SourceSync({
      store: this.store,
      records: this.records,
      blobs: this.blobs,
      ...(parts.secret && { secret: parts.secret }),
      ...(parts.resolvePrincipal && { resolvePrincipal: parts.resolvePrincipal }),
    });
    this.normalization = new Normalization({
      store: this.store,
      records: this.records,
      blobs: this.blobs,
      models: this.models,
    });
    this.vocabulary = parts.vocabulary ?? (() => undefined);
    this.extraction = new Extraction({
      store: this.store,
      records: this.records,
      models: this.models,
      discoverFacts: parts.discoverFacts,
      ...(parts.vocabulary && { vocabulary: parts.vocabulary }),
    });
    const clock = parts.clock && { clock: parts.clock };
    this.governance = new Governance({ store: this.store, records: this.records, ...clock });
    this.freshness = new Freshness({ store: this.store, records: this.records, ...clock });
    this.topics = new Topics({ store: this.store, records: this.records, models: this.models, ...clock });
    this.inbox = new Inbox({
      store: this.store,
      records: this.records,
      ...clock,
      fallbackOwner: async (tenant, space) => {
        const entry = await this.directory.space(space);
        return entry?.tenant_id === tenant ? entry.owner_ids[0] : undefined;
      },
    });
    this.assistant = new Assistant({ inbox: this.inbox });
    this.comments = new DocumentComments(this.records, this.clock);
    const graph = parts.graph ?? new MemoryGraph();
    this.authz = new AuthzService(graph, this.store);
    this.directory = new Directory(this.records, graph);
    const memory = this.store instanceof MemoryStore ? this.store : undefined;
    this.vectors = memory ? new MemoryVectorIndex(memory) : new PgVectorIndex(parts.pool as Pool);
    this.keywords = memory ? new MemoryKeywordIndex(memory) : new PgSearchIndex(parts.pool as Pool);
    const answering = {
      store: this.store,
      records: this.records,
      models: this.models,
      authz: this.authz,
      vectors: this.vectors,
      keywords: this.keywords,
      verdicts: this.governance,
      staleness: this.freshness,
      ...clock,
      ...(parts.readOnUse && {
        readOnUse: (citations: readonly Citation[], who: Principal) => readForAnswer(this, citations, who),
      }),
    };
    this.retrieval = new Retrieval(answering);
    this.compact = new Retrieval({ ...answering, answerSources: parts.compactSources ?? COMPACT_SOURCES });
    const components: Running[] = [
      { group: "source-sync", handlers: () => this.sync.handlers() },
      { group: "normalization", handlers: () => this.normalization.handlers() },
      { group: "extraction", handlers: () => this.extraction.handlers() },
      { group: "governance", handlers: () => this.governance.handlers() },
      { group: "freshness", handlers: () => this.freshness.handlers() },
      { group: "page-compiler", handlers: () => this.topics.handlers() },
      { group: "collaboration", handlers: () => ({ ...this.inbox.handlers(), ...this.assistant.handlers() }) },
      { group: "retrieval", handlers: () => this.retrieval.handlers() },
    ];
    for (const c of components) {
      for (const [type, handler] of Object.entries(c.handlers())) this.consumer.subscribe(type, c.group, handler);
    }
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const blobs = new LocalBlobStore(options.blobDir);
    const closers: (() => Promise<unknown>)[] = [];
    let models = options.models;
    let ledger = options.ledger;
    if (!models) {
      const gateway = await Gateway.create(loadGatewayConfig(join(workspaceRoot(), "config", "gateway.dev.yaml")), {
        ...(options.clock && { clock: options.clock }),
      });
      closers.push(() => gateway.close());
      models = gateway;
      ledger ??= gateway;
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
      discoverFacts: options.discoverFacts,
      readOnUse: options.readOnUse,
      ...(options.secret && { secret: options.secret }),
      ...(options.resolvePrincipal && { resolvePrincipal: options.resolvePrincipal }),
      ...(options.vocabulary && { vocabulary: options.vocabulary }),
      ...(options.clock && { clock: options.clock }),
      ...(options.graph && { graph: options.graph }),
      ...(options.compactSources && { compactSources: options.compactSources }),
      ...(options.deliveryMode && { deliveryMode: options.deliveryMode }),
    };

    let engine: Engine;
    if (options.databaseUrl) {
      await applyMigrations(options.databaseUrl, await engineMigrations());
      const pool = await openPool(options.databaseUrl);
      closers.push(() => pool.end());
      engine = new Engine({
        store: new PostgresStore(pool),
        records: new PgRecords(pool),
        blobs,
        models,
        ...(ledger && { ledger }),
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
        ...(ledger && { ledger }),
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

  /**
   * Read on the documents whose reading stopped at a spent budget or a model out of reach,
   * then deliver what that read in the background. A long-running engine calls it every
   * RESUME_EVERY_MS; a company whose budget is still spent costs one refused call. Returns
   * how many indexing or reading tasks completed. An optional source limits manual retries.
   */
  resumeReading(sourceId?: string): Promise<number> {
    if (this.#closing) return Promise.resolve(0);
    const run = (async () => {
      const indexed = await this.retrieval.resume(sourceId);
      const done = await this.extraction.resume(sourceId);
      if (done) this.settleLater();
      return done + indexed;
    })();
    this.#reading.add(run);
    return run.finally(() => this.#reading.delete(run));
  }

  /** Subscribe an extra handler, for reports and tests that watch the events go by. */
  observe(eventType: string, group: string, handler: EventHandler): void {
    if (this.#workers) throw new Error("cannot observe new events after delivery has started");
    this.consumer.subscribe(eventType, group, handler);
  }

  /**
   * Run the outbox relay (when backed by Postgres) and all subscribed consumer groups
   * continuously in the background until close(). Requires deliveryMode: "service" so
   * multiple replicas share the bus with a non-zero visibility timeout and Postgres RELAY_LOCK.
   * Call after any observe() subscriptions.
   */
  startDelivery(): void {
    if (this.deliveryMode !== "service") {
      throw new Error('startDelivery requires deliveryMode: "service"');
    }
    if (this.#closing || this.#workers) return;
    const workers: Promise<unknown>[] = [
      this.consumer.run().catch((error: unknown) => {
        if (!this.#closing) log.error("event consumer stopped", { error });
      }),
    ];
    if (this.#relay) {
      workers.push(
        this.#relay.run().catch((error: unknown) => {
          if (!this.#closing) log.error("outbox relay stopped", { error });
        }),
      );
    }
    this.#workers = workers;
  }

  /** True while background service-mode workers are running. */
  get isServiceRunning(): boolean {
    return this.#workers !== undefined && !this.#closing;
  }

  /**
   * Relay the outbox and deliver to every consumer group until a full round moves nothing,
   * after any delivery already running. Returns the number of deliveries. When continuous
   * background delivery is active (startDelivery), waits until the outbox and all consumer
   * groups are idle (without bypassing RELAY_LOCK or competing with the running consumer
   * loops) and returns 0.
   */
  settle(maxRounds = 10_000): Promise<number> {
    if (this.#workers) return this.#waitUntilIdle(maxRounds);
    return this.#serially(() => (this.#workers ? this.#waitUntilIdle(maxRounds) : this.#deliver(maxRounds)));
  }

  async #outboxState(): Promise<{ pending: boolean; maxSeq: string }> {
    if (!this.#pool || !this.#relay) return { pending: false, maxSeq: "0" };
    // Uses the partial index outbox_pending (WHERE relayed_at IS NULL) and the PK index on seq,
    // avoiding a full scan of retained relayed history on each poll.
    const { rows } = await this.#pool.query<{ pending: boolean; max_seq: string }>(
      "SELECT EXISTS (SELECT 1 FROM bus.outbox WHERE relayed_at IS NULL) AS pending, COALESCE((SELECT MAX(seq) FROM bus.outbox), 0)::text AS max_seq",
    );
    return { pending: rows[0]?.pending ?? false, maxSeq: rows[0]?.max_seq ?? "0" };
  }

  async #waitUntilIdle(maxChecks: number): Promise<number> {
    for (let check = 0; check < maxChecks && !this.#closing && this.#workers; check++) {
      const before = await this.#outboxState();
      if (!before.pending && (await this.consumer.isIdle())) {
        // Re-check outbox sequence (and transport when in-memory) so a handler that
        // published downstream work right before acking cannot slip past the barrier.
        const after = await this.#outboxState();
        if (!after.pending && after.maxSeq === before.maxSeq && (this.#relay || (await this.consumer.isIdle()))) {
          return 0;
        }
      }
      await sleep(20);
    }
    if (!this.#closing && this.#workers) {
      throw new Error(`background delivery still pending after ${maxChecks} checks`);
    }
    return 0;
  }

  /** Settle in the background, as an upload asks: its answer does not wait for the reading. */
  settleLater(): void {
    if (this.#workers || this.#closing || this.#queued) return;
    this.#queued = true;
    this.#serially(() => {
      this.#queued = false;
      return this.#workers ? Promise.resolve(0) : this.#deliver(10_000);
    }).catch((error: unknown) => log.warn("background delivery failed", { error }));
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#delivering.then(run);
    this.#delivering = next.catch(() => undefined);
    return next;
  }

  async #deliver(maxRounds: number): Promise<number> {
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
    this.#closing = true;
    await this.sync.close();
    await Promise.allSettled(this.#reading);
    const workers = this.#workers;
    if (workers) {
      await Promise.allSettled([this.#relay?.stop(), this.consumer.stop()]);
      await Promise.allSettled(workers);
      this.#workers = undefined;
      await this.#delivering;
    } else {
      await this.settle();
    }
    for (const close of this.#closers) {
      await close().catch((error: unknown) => log.warn("close failed", { error }));
    }
  }
}
