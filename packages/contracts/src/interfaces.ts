/**
 * Component interfaces.
 *
 * Components talk in exactly three ways: events on the bus, the knowledge store's repository
 * API, and synchronous calls to access control and the model gateway. Plugins (connectors,
 * parsers, extractors, diagram compilers, index backends, model providers) register by name
 * through the kernel's plugin registry. Every type that crosses a component boundary comes
 * from generated.ts; these interfaces only add behaviour.
 *
 * Contract data keeps the schema's snake_case field names; method names and option bags are
 * camelCase. A value that is not there is `undefined`.
 */

import type {
  AclSnapshot,
  AgentResult,
  AgentRunContext,
  AgentSpec,
  AnswerQuery,
  BlobRef,
  ChangeEvent,
  ChangePage,
  Chunk,
  Claim,
  ClaimDerivation,
  ClaimEvidence,
  ClaimQuery,
  Completion,
  CompletionRequest,
  ConnectorCapabilities,
  Cursor,
  DataColumn,
  DataRef,
  DataTable,
  Decision,
  DependencyEdge,
  DerivedReadDecision,
  DiagramSpec,
  EmbedRequest,
  EmbedResult,
  EventEnvelope,
  FileMeta,
  GroundedAnswer,
  IndexFilter,
  IndexHit,
  LineageGraph,
  ListPage,
  NormalizedDocument,
  OcrRequest,
  OcrResult,
  PageSnapshot,
  PageVersionInfo,
  ParseHints,
  ParseResult,
  Permission,
  Principal,
  RerankRequest,
  RerankResult,
  ResourceRef,
  ScopeSpec,
  SearchQuery,
  SearchResult,
  Source,
  SourceBlock,
  SourceRef,
  SourceVersion,
  Span,
  SubscriptionInfo,
  ToolSpec,
  Unchanged,
  Version,
} from "./generated.ts";

// ---------------------------------------------------------------- platform

/** Binary objects: uploaded files, images, view bundles. */
export interface BlobStore {
  put(data: Uint8Array, options: { mimeType: string; filename?: string }): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
  delete(ref: BlobRef): Promise<void>;
}

export type EventHandler = (event: EventEnvelope) => Promise<void>;

/**
 * Publishes events outside a store transaction (it opens its own outbox transaction).
 * Inside a knowledge-store transaction, use StoreTx.publish instead, so the events commit
 * together with the data.
 */
export interface EventPublisher {
  publish(...events: EventEnvelope[]): Promise<void>;
}

/**
 * Consumer-group subscription. Delivery is at least once: handlers must be idempotent.
 * A handler that throws is retried; after the bus's delivery limit the event goes to the
 * group's dead-letter stream.
 */
export interface EventSubscriber {
  subscribe(eventType: string, group: string, handler: EventHandler): void;
  run(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------- access control

/**
 * Permission checks. Agent principals carry on_behalf_of; their rights are the person's
 * rights intersected with the agent's scopes.
 */
export interface AuthZ {
  check(who: Principal, perm: Permission, res: ResourceRef): Promise<Decision>;
  checkMany(who: Principal, perm: Permission, resources: readonly ResourceRef[]): Promise<Decision[]>;
  /** Filter pushed into search indexes before ranking. */
  scopeFilter(who: Principal, perm: Permission): Promise<IndexFilter>;
  /** The derived-knowledge rule: readable only through sources the viewer can read now. */
  canReadDerived(who: Principal, unitId: string): Promise<DerivedReadDecision>;
}

/**
 * Writes source ACLs into the permission system (driven by acl.changed). Both return the
 * consistency token of the write (a SpiceDB ZedToken), for at-least-as-fresh reads after it.
 */
export interface AclMirror {
  mirror(snapshot: AclSnapshot, options: { spaceId: string }): Promise<string | undefined>;
  forget(sourceId: string, externalId: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------- model gateway and agents

/** The only way to call a model. Routes by sensitivity, enforces budgets, caches and meters. */
export interface ModelGateway {
  complete(req: CompletionRequest): Promise<Completion>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
  rerank(req: RerankRequest): Promise<RerankResult>;
  ocr(req: OcrRequest): Promise<OcrResult>;
}

/**
 * A tool for built-in agents. Its spec is the same schema the agent API offers to outside
 * agents over MCP. Tools with effect "propose" only create proposals or todos; no tool
 * changes knowledge directly.
 */
export interface Tool {
  readonly spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: AgentRunContext): Promise<unknown>;
}

/**
 * The loop shared by every built-in agent: tool selection through schema-constrained output,
 * step and token limits, approval gates, traces and replay.
 */
export interface AgentRuntime {
  run(spec: AgentSpec, input: unknown, ctx: AgentRunContext): Promise<AgentResult>;
}

// ---------------------------------------------------------------- connectors

/** Where a connector should deliver push events. */
export interface WebhookEndpoint {
  readonly url: string;
  readonly secretRef?: string;
}

/** An inbound webhook request, unparsed. */
export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAt: Date;
}

/** What the runtime gives a connector instance. */
export interface ConnectorContext {
  readonly blobs: BlobStore;
  secret(name: string): Promise<string>;
}

/**
 * A source plugin. list and fetch are required; the optional methods are capabilities,
 * advertised through capabilities().
 */
export interface Connector {
  readonly type: string;
  capabilities(): ConnectorCapabilities;
  list(scope: ScopeSpec, cursor?: Cursor): Promise<ListPage>;
  fetch(ref: SourceRef, known?: Version): Promise<NormalizedDocument | Unchanged>;
  changes?(scope: ScopeSpec, cursor: Cursor): Promise<ChangePage>;
  subscribe?(scope: ScopeSpec, sink: WebhookEndpoint): Promise<SubscriptionInfo[]>;
  /** Verify the signature and turn a push into change hints. Throws on a bad signature. */
  parseWebhook?(req: RawRequest): Promise<ChangeEvent[]>;
  acl?(ref: SourceRef): Promise<AclSnapshot>;
}

export type ConnectorFactory = (source: Source, ctx: ConnectorContext) => Connector;

// ---------------------------------------------------------------- parsers

export interface ParserContext {
  readonly blobs: BlobStore;
  readonly models: ModelGateway;
}

/**
 * A stateless parser, called by normalization. Heavy parsers (layout models, OCR pipelines) run
 * in the Python parsing worker behind this same contract.
 */
export interface Parser {
  readonly name: string;
  readonly version: string;
  /** How well this parser handles the file, 0 to 1. The router picks the highest. */
  accepts(meta: FileMeta): number;
  parse(file: BlobRef, meta: FileMeta, hints: ParseHints, ctx: ParserContext): Promise<ParseResult>;
}

// ---------------------------------------------------------------- extractors, diagram compilers

/** Passed to every compile-stage plugin run. */
export interface RunContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly budgetKey: string;
  readonly store: KnowledgeStore;
  readonly models: ModelGateway;
  readonly settings: Readonly<Record<string, unknown>>;
}

export type ExtractorStage = "claims" | "entities" | "sop" | "model";

/** A versioned compile stage. Bumping version invalidates its outputs through freshness. */
export interface Extractor<I, O> {
  readonly stage: ExtractorStage;
  readonly name: string;
  readonly version: string;
  run(input: I, ctx: RunContext): Promise<O>;
}

/** Compiles structure (an SOP, an entity neighbourhood) into a diagram spec. Deterministic. */
export interface DiagramCompiler {
  readonly kind: string;
  readonly version: string;
  compile(structure: unknown): DiagramSpec;
}

// ---------------------------------------------------------------- knowledge store

/** Writes inside one database transaction. Events published here commit with the data. */
export interface StoreTx {
  /**
   * Store an immutable version, with the spans of a document that has no block structure.
   * Spans whose ID already exists are kept.
   */
  putSourceVersion(version: SourceVersion, spans?: readonly Span[]): Promise<void>;
  /**
   * Store a stored version's blocks and the spans it introduces. Blocks may list spans of
   * earlier versions by ID. A version's blocks are written once; writing them again is a no-op.
   */
  putBlocks(sourceVersionId: string, blocks: readonly SourceBlock[], spans: readonly Span[]): Promise<void>;
  putChunks(
    chunks: readonly Chunk[],
    embeddings?: Readonly<Record<string, readonly number[]>>,
    options?: { model?: string },
  ): Promise<void>;
  removeChunks(chunkIds: readonly string[]): Promise<void>;
  /**
   * Insert or update claims. Every claim must have supporting evidence or a derivation, and
   * every evidence quote must be a substring of its span.
   */
  upsertClaims(
    claims: readonly Claim[],
    evidence: readonly ClaimEvidence[],
    derivations?: readonly ClaimDerivation[],
  ): Promise<string[]>;
  /** Close the old claim's "known when" interval. Claims are never deleted. */
  supersede(claimId: string, by: string, reason: string): Promise<void>;
  /** Replace the recorded inputs of each artifact in edges with these edges. */
  recordDependencies(edges: readonly DependencyEdge[]): Promise<void>;
  /** Store a new page version. Versions are immutable and must increase by one. */
  putPageSnapshot(snapshot: PageSnapshot): Promise<void>;
  /**
   * Keep a document's ACL as read from its source (source sync writes it before
   * acl.changed). Snapshots are kept per acl_hash, so an event can name the exact one it means.
   */
  putAclSnapshot(snapshot: AclSnapshot): Promise<void>;
  publish(...events: EventEnvelope[]): Promise<void>;
}

/** The only way to read and write knowledge tables. */
export interface KnowledgeStore {
  /** Run fn in one transaction: it commits when fn resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  getSourceVersion(versionId: string): Promise<SourceVersion | undefined>;
  latestSourceVersion(sourceId: string, externalId: string): Promise<SourceVersion | undefined>;
  getSpans(spanIds: readonly string[]): Promise<Span[]>;
  /** The version's spans in reading order: through its blocks, or the spans it was stored with. */
  spansOf(sourceVersionId: string): Promise<Span[]>;
  blocksOf(sourceVersionId: string): Promise<SourceBlock[]>;
  getChunks(chunkIds: readonly string[]): Promise<Chunk[]>;
  chunksOf(sourceVersionId: string): Promise<Chunk[]>;
  getClaims(claimIds: readonly string[]): Promise<Claim[]>;
  evidenceOf(claimIds: readonly string[]): Promise<ClaimEvidence[]>;
  claimsCiting(spanIds: readonly string[]): Promise<string[]>;
  /** Bitemporal read. knownAt defaults to now (current beliefs); validAt to no filter. */
  asOf(query: ClaimQuery, options?: { validAt?: Date; knownAt?: Date }): Promise<Claim[]>;
  lineage(unitId: string, depth?: number): Promise<LineageGraph>;
  /** Artifacts built directly from any of the given inputs. */
  dependents(artifactIds: readonly string[]): Promise<string[]>;
  getPage(pageId: string, version?: number): Promise<PageSnapshot | undefined>;
  pageHistory(pageId: string): Promise<PageVersionInfo[]>;
  /** The snapshot with that hash, or the latest captured one when aclHash is not given. */
  getAclSnapshot(sourceId: string, externalId: string, aclHash?: string): Promise<AclSnapshot | undefined>;
  /**
   * Run a chart's or view's DataRef. Rows keep their claim IDs so the serving path can drop
   * rows the reader may not see before injecting the data.
   */
  resolveData(ref: DataRef): Promise<DataTable>;
}

/**
 * Runs registered queries for QueryData (a connector-backed table, a read-only SQL view).
 * Never free-form queries from page content.
 */
export interface DataProvider {
  readonly name: string;
  run(queryId: string, params: Readonly<Record<string, unknown>>, columns: readonly DataColumn[]): Promise<DataTable>;
}

/** Vector search over chunks. Prototype: pgvector inside the knowledge store; product: Milvus. */
export interface VectorIndex {
  readonly name: string;
  upsert(items: Readonly<Record<string, readonly number[]>>, options: { model: string }): Promise<void>;
  delete(chunkIds: readonly string[]): Promise<void>;
  search(vector: readonly number[], k: number, filter: IndexFilter): Promise<IndexHit[]>;
}

/** BM25 search over chunks. Prototype: ParadeDB pg_search with jieba; product: Elasticsearch or OpenSearch. */
export interface KeywordIndex {
  readonly name: string;
  search(text: string, k: number, filter: IndexFilter): Promise<IndexHit[]>;
}

// ---------------------------------------------------------------- retrieval

export interface Retriever {
  search(q: SearchQuery, who: Principal): Promise<SearchResult>;
  answer(q: AnswerQuery, who: Principal): Promise<GroundedAnswer>;
}
