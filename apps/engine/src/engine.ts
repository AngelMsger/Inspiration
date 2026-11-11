import { join } from "node:path";
import { AuthzService, Directory, type Graph, MemoryGraph } from "@inspiration/access-control";
import { Assistant, Inbox } from "@inspiration/collaboration";
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
  /** The most a long-context answer reads, raw or governed, in tokens; LONG_CONTEXT_TOKENS unless given. */
  contextTokens?: number;
  /** How many passages and statements a compact answer reads (Engine.compact); COMPACT_SOURCES unless given. */
  compactSources?: AnswerSources;
}

/** How often a long-running engine reads on where reading stopped (Engine.resumeReading). */
export const RESUME_EVERY_MS = 15 * 60_000;

/** A component as the engine runs it: event handlers by type, under the component's consumer group. */
interface Running {
  readonly group: string;
  handlers(): Record<string, EventHandler>;
}

/**
 * The engine process: one store, one blob store, one event bus, and the built components
 * subscribed under their own consumer groups. Long-running deployments drain work with settleLater(); batch
 * runs (ingest a corpus, then report) call settle() to deliver until nothing is left.
 */
export class Engine {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly models: ModelGateway;
  /** The gateway's ledger and budgets, for usage; absent when the engine was not given one. */
  readonly ledger: Gateway | undefined;
  /** What the engine takes as now. */
  readonly clock: () => Date;
  readonly discoverFacts: boolean;
  readonly sync: SourceSync;
  readonly normalization: Normalization;
  readonly extraction: Extraction;
  readonly governance: Governance;
  readonly freshness: Freshness;
  readonly topics: Topics;
  readonly inbox: Inbox;
  /** Decide for me: the assistant's decisions on members' todos, and their standing delegations. */
  readonly assistant: Assistant;
  readonly authz: AuthzService;
  /** The copy of the business layer's tenants and members, and the spaces, granted in the same graph as authz reads. */
  readonly directory: Directory;
  /** Each tenant's predicate catalogue, as extraction reads it; the inbox names facts by it. */
  readonly vocabulary: NonNullable<ExtractionOptions["vocabulary"]>;
  /** Search, and the standard answer: as many passages as statements. */
  readonly retrieval: Retrieval;
  /**
   * The rivals answers are measured against, over the same documents and model: a mature
   * retrieval over the same chunks and search, without statements or governance, and a model
   * that reads every document (corpora that fit).
   */
  readonly baselines: { mature: Retrieval; long_context: Retrieval };
  /** The knowledge base answering from everything the asker may read, after governance (corpora that fit). */
  readonly governedLongContext: Retrieval;
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
  readonly #closers: (() => Promise<unknown>)[] = [];
  /** Deliveries run one at a time: two at once could hand both the same event. */
  #delivering: Promise<unknown> = Promise.resolve();
  /** Whether a background delivery waits to start; one waiting covers every later ask. */
  #queued = false;

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
    vocabulary?: ExtractionOptions["vocabulary"];
    clock?: () => Date;
    graph?: Graph;
    contextTokens?: number;
    compactSources?: AnswerSources;
  }) {
    this.discoverFacts = parts.discoverFacts === true;
    this.store = parts.store;
    this.records = parts.records;
    this.blobs = parts.blobs;
    this.models = parts.models;
    this.ledger = parts.ledger;
    this.clock = parts.clock ?? (() => new Date());
    this.transport = parts.transport;
    this.#relay = parts.relay;
    this.#pool = parts.pool;
    // Batch runs retry a failed delivery at once instead of after a visibility timeout.
    this.consumer = new Consumer(parts.transport, { name: "engine", visibilityTimeoutMs: 0, maxDeliveries: 3 });
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
      ...(parts.discoverFacts && {
        fallbackOwner: async (tenant, space) => {
          const entry = await this.directory.space(space);
          return entry?.tenant_id === tenant ? entry.owner_ids[0] : undefined;
        },
      }),
    });
    this.assistant = new Assistant({ inbox: this.inbox });
    const graph = parts.graph ?? new MemoryGraph();
    this.authz = new AuthzService(graph, this.store);
    this.directory = new Directory(this.records, graph);
    const memory = this.store instanceof MemoryStore ? this.store : undefined;
    const indexes = {
      store: this.store,
      records: this.records,
      models: this.models,
      authz: this.authz,
      vectors: memory ? new MemoryVectorIndex(memory) : new PgVectorIndex(parts.pool as Pool),
      keywords: memory ? new MemoryKeywordIndex(memory) : new PgSearchIndex(parts.pool as Pool),
      ...clock,
    };
    const governed = { ...indexes, verdicts: this.governance, staleness: this.freshness };
    const context = parts.contextTokens && { contextTokens: parts.contextTokens };
    this.retrieval = new Retrieval(governed);
    this.baselines = {
      mature: new Retrieval({ ...indexes, baseline: "mature" }),
      long_context: new Retrieval({ ...indexes, baseline: "long_context", ...context }),
    };
    this.governedLongContext = new Retrieval({ ...governed, readAll: true, ...context });
    this.compact = new Retrieval({ ...governed, answerSources: parts.compactSources ?? COMPACT_SOURCES });
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
      ...(options.secret && { secret: options.secret }),
      ...(options.resolvePrincipal && { resolvePrincipal: options.resolvePrincipal }),
      ...(options.vocabulary && { vocabulary: options.vocabulary }),
      ...(options.clock && { clock: options.clock }),
      ...(options.graph && { graph: options.graph }),
      ...(options.contextTokens && { contextTokens: options.contextTokens }),
      ...(options.compactSources && { compactSources: options.compactSources }),
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
   * how many documents were read to the end.
   */
  async resumeReading(): Promise<number> {
    const done = await this.extraction.resume();
    if (done) this.settleLater();
    return done;
  }

  /** Subscribe an extra handler, for reports and tests that watch the events go by. */
  observe(eventType: string, group: string, handler: EventHandler): void {
    this.consumer.subscribe(eventType, group, handler);
  }

  /**
   * Relay the outbox and deliver to every consumer group until a full round moves nothing,
   * after any delivery already running. Returns the number of deliveries.
   */
  settle(maxRounds = 10_000): Promise<number> {
    return this.#serially(() => this.#deliver(maxRounds));
  }

  /** Settle in the background, as an upload asks: its answer does not wait for the reading. */
  settleLater(): void {
    if (this.#queued) return;
    this.#queued = true;
    this.#serially(() => {
      this.#queued = false;
      return this.#deliver(10_000);
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
    await this.#delivering;
    for (const close of this.#closers) {
      await close().catch((error: unknown) => log.warn("close failed", { error }));
    }
  }
}
