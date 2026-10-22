"""Module interfaces.

Modules talk in exactly three ways: events on the bus, the knowledge store's repository
API (M10), and synchronous calls to AuthZ (M13) and the model gateway (M14). Plugins
(connectors, parsers, extractors, diagram compilers, index backends, model providers)
register by name through inspiration.kernel.plugins. Every type that crosses a module
boundary comes from inspiration.contracts.models; these Protocols only add behaviour.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, ClassVar, Protocol, runtime_checkable

from .models import (
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
    SourceRef,
    SourceVersion,
    Span,
    SubscriptionInfo,
    ToolSpec,
    Unchanged,
    Version,
)

# ---------------------------------------------------------------- platform


class BlobStore(Protocol):
    """Binary objects: uploaded files, images, view bundles."""

    async def put(self, data: bytes, *, mime_type: str, filename: str | None = None) -> BlobRef: ...

    async def get(self, ref: BlobRef) -> bytes: ...

    async def delete(self, ref: BlobRef) -> None: ...


type EventHandler = Callable[[EventEnvelope], Awaitable[None]]


class EventPublisher(Protocol):
    """Publishes events outside a store transaction (it opens its own outbox transaction).

    Inside a knowledge-store transaction, use StoreTx.publish instead, so the events commit
    together with the data.
    """

    async def publish(self, *events: EventEnvelope) -> None: ...


class EventSubscriber(Protocol):
    """Consumer-group subscription. Delivery is at least once: handlers must be idempotent.

    A handler that raises is retried; after the bus's delivery limit the event goes to the
    group's dead-letter stream.
    """

    def subscribe(self, event_type: str, group: str, handler: EventHandler) -> None: ...

    async def run(self) -> None: ...

    async def stop(self) -> None: ...


# ---------------------------------------------------------------- M13 AuthZ


class AuthZ(Protocol):
    """Permission checks. Agent principals carry on_behalf_of; their rights are the
    person's rights intersected with the agent's scopes."""

    async def check(self, who: Principal, perm: Permission, res: ResourceRef) -> Decision: ...

    async def check_many(
        self, who: Principal, perm: Permission, resources: Sequence[ResourceRef]
    ) -> list[Decision]: ...

    async def scope_filter(self, who: Principal, perm: Permission) -> IndexFilter:
        """Filter pushed into search indexes before ranking."""
        ...

    async def can_read_derived(self, who: Principal, unit_id: str) -> DerivedReadDecision:
        """The derived-knowledge rule: readable only through sources the viewer can read now."""
        ...


class AclMirror(Protocol):
    """Writes source ACLs into the permission system (M13, driven by acl.changed)."""

    async def mirror(self, snapshot: AclSnapshot, *, space_id: str) -> None: ...

    async def forget(self, source_id: str, external_id: str) -> None: ...


# ---------------------------------------------------------------- M14 model gateway


class ModelGateway(Protocol):
    """The only way to call a model. Routes by sensitivity, enforces budgets, caches and meters."""

    async def complete(self, req: CompletionRequest) -> Completion: ...

    async def embed(self, req: EmbedRequest) -> EmbedResult: ...

    async def rerank(self, req: RerankRequest) -> RerankResult: ...

    async def ocr(self, req: OcrRequest) -> OcrResult: ...


class Tool(Protocol):
    """A tool for built-in agents. Its spec is the same schema the agent gateway (M12)
    offers to outside agents over MCP. Tools with effect "propose" only create proposals
    or todos; no tool changes knowledge directly."""

    spec: ToolSpec

    async def __call__(self, arguments: Mapping[str, Any], ctx: AgentRunContext) -> Any: ...


class AgentRuntime(Protocol):
    """The loop shared by every built-in agent (M14): tool selection through
    schema-constrained output, step and token limits, approval gates, traces and replay."""

    async def run(self, spec: AgentSpec, input: Any, ctx: AgentRunContext) -> AgentResult: ...


# ---------------------------------------------------------------- M1 connectors


@dataclass(frozen=True)
class WebhookEndpoint:
    """Where a connector should deliver push events."""

    url: str
    secret_ref: str | None = None


@dataclass(frozen=True)
class RawRequest:
    """An inbound webhook request, unparsed."""

    method: str
    path: str
    headers: Mapping[str, str]
    body: bytes
    received_at: datetime


class ConnectorContext(Protocol):
    """What the runtime gives a connector instance."""

    @property
    def blobs(self) -> BlobStore: ...

    async def secret(self, name: str) -> str: ...


class Connector(Protocol):
    """A source plugin. list and fetch are required; the Supports* protocols are optional
    capabilities, advertised through capabilities()."""

    type: ClassVar[str]

    def capabilities(self) -> ConnectorCapabilities: ...

    async def list(self, scope: ScopeSpec, cursor: Cursor | None = None) -> ListPage: ...

    async def fetch(self, ref: SourceRef, known: Version | None = None) -> NormalizedDocument | Unchanged: ...


type ConnectorFactory = Callable[[Source, ConnectorContext], Connector]


@runtime_checkable
class SupportsChanges(Protocol):
    async def changes(self, scope: ScopeSpec, cursor: Cursor) -> ChangePage: ...


@runtime_checkable
class SupportsSubscribe(Protocol):
    async def subscribe(self, scope: ScopeSpec, sink: WebhookEndpoint) -> list[SubscriptionInfo]: ...


@runtime_checkable
class SupportsWebhooks(Protocol):
    async def parse_webhook(self, req: RawRequest) -> list[ChangeEvent]:
        """Verify the signature and turn a push into change hints. Raise on a bad signature."""
        ...


@runtime_checkable
class SupportsAcl(Protocol):
    async def acl(self, ref: SourceRef) -> AclSnapshot: ...


# ---------------------------------------------------------------- M3 parsers


class ParserContext(Protocol):
    @property
    def blobs(self) -> BlobStore: ...

    @property
    def models(self) -> ModelGateway: ...


class Parser(Protocol):
    """A stateless parser plugin, called by the normalizer (M4)."""

    name: ClassVar[str]
    version: ClassVar[str]

    def accepts(self, meta: FileMeta) -> float:
        """How well this parser handles the file, 0 to 1. The router picks the highest."""
        ...

    async def parse(self, file: BlobRef, meta: FileMeta, hints: ParseHints, ctx: ParserContext) -> ParseResult: ...


# ---------------------------------------------------------------- M5 extractors, M8 diagram compilers


@dataclass
class RunContext:
    """Passed to every compile-stage plugin run."""

    tenant_id: str
    run_id: str
    budget_key: str
    store: KnowledgeStore
    models: ModelGateway
    settings: Mapping[str, Any] = field(default_factory=dict)


class Extractor[I, O](Protocol):
    """A versioned compile stage. Bumping version invalidates its outputs through M6."""

    stage: ClassVar[str]  # "claims" | "entities" | "sop" | "model"
    name: ClassVar[str]
    version: ClassVar[str]

    async def run(self, input: I, ctx: RunContext) -> O: ...


class DiagramCompiler(Protocol):
    """Compiles structure (an SOP, an entity neighbourhood) into a diagram spec. Deterministic."""

    kind: ClassVar[str]
    version: ClassVar[str]

    def compile(self, structure: Any) -> DiagramSpec: ...


# ---------------------------------------------------------------- M10 knowledge store


class StoreTx(Protocol):
    """Writes inside one database transaction. Events published here commit with the data."""

    async def put_source_version(self, version: SourceVersion, spans: Sequence[Span]) -> None:
        """Store an immutable version and its spans. Spans whose ID already exists are kept."""
        ...

    async def put_chunks(
        self,
        chunks: Sequence[Chunk],
        embeddings: Mapping[str, Sequence[float]] | None = None,
        *,
        model: str | None = None,
    ) -> None: ...

    async def remove_chunks(self, chunk_ids: Sequence[str]) -> None: ...

    async def upsert_claims(
        self,
        claims: Sequence[Claim],
        evidence: Sequence[ClaimEvidence],
        derivations: Sequence[ClaimDerivation] = (),
    ) -> list[str]:
        """Insert or update claims. Every claim must have supporting evidence or a derivation,
        and every evidence quote must be a substring of its span."""
        ...

    async def supersede(self, claim_id: str, by: str, reason: str) -> None:
        """Close the old claim's "known when" interval. Claims are never deleted."""
        ...

    async def record_dependencies(self, edges: Sequence[DependencyEdge]) -> None:
        """Replace the recorded inputs of each artifact in edges with these edges."""
        ...

    async def put_page_snapshot(self, snapshot: PageSnapshot) -> None:
        """Store a new page version. Versions are immutable and must increase by one."""
        ...

    async def put_acl_snapshot(self, snapshot: AclSnapshot) -> None:
        """Keep a document's ACL as read from its source (M2 writes it before acl.changed).
        Snapshots are kept per acl_hash, so an event can name the exact one it means."""
        ...

    async def publish(self, *events: EventEnvelope) -> None: ...


class KnowledgeStore(Protocol):
    """The only way to read and write knowledge tables (M10)."""

    def transaction(self) -> AbstractAsyncContextManager[StoreTx]: ...

    async def get_source_version(self, version_id: str) -> SourceVersion | None: ...

    async def latest_source_version(self, source_id: str, external_id: str) -> SourceVersion | None: ...

    async def get_spans(self, span_ids: Sequence[str]) -> list[Span]: ...

    async def spans_of(self, source_version_id: str) -> list[Span]: ...

    async def get_chunks(self, chunk_ids: Sequence[str]) -> list[Chunk]: ...

    async def chunks_of(self, source_version_id: str) -> list[Chunk]: ...

    async def get_claims(self, claim_ids: Sequence[str]) -> list[Claim]: ...

    async def evidence_of(self, claim_ids: Sequence[str]) -> list[ClaimEvidence]: ...

    async def claims_citing(self, span_ids: Sequence[str]) -> list[str]: ...

    async def as_of(
        self, query: ClaimQuery, *, valid_at: datetime | None = None, known_at: datetime | None = None
    ) -> list[Claim]:
        """Bi-temporal read. known_at defaults to now (current beliefs); valid_at to no filter."""
        ...

    async def lineage(self, unit_id: str, depth: int = 3) -> LineageGraph: ...

    async def dependents(self, artifact_ids: Sequence[str]) -> list[str]:
        """Artifacts built directly from any of the given inputs."""
        ...

    async def get_page(self, page_id: str, version: int | None = None) -> PageSnapshot | None: ...

    async def page_history(self, page_id: str) -> list[PageVersionInfo]: ...

    async def get_acl_snapshot(
        self, source_id: str, external_id: str, acl_hash: str | None = None
    ) -> AclSnapshot | None:
        """The snapshot with that hash, or the latest captured one when acl_hash is None."""
        ...

    async def resolve_data(self, ref: DataRef) -> DataTable:
        """Run a chart's or view's DataRef. Rows keep their claim IDs so the serving path can
        drop rows the reader may not see before injecting the data."""
        ...


class DataProvider(Protocol):
    """Runs registered queries for QueryData (a connector-backed table, a read-only SQL view).
    Never free-form queries from page content."""

    name: ClassVar[str]

    async def run(self, query_id: str, params: Mapping[str, Any], columns: Sequence[DataColumn]) -> DataTable: ...


class VectorIndex(Protocol):
    """Vector search over chunks. Prototype: pgvector inside M10; product: Milvus."""

    name: ClassVar[str]

    async def upsert(self, items: Mapping[str, Sequence[float]], *, model: str) -> None: ...

    async def delete(self, chunk_ids: Sequence[str]) -> None: ...

    async def search(self, vector: Sequence[float], k: int, flt: IndexFilter) -> list[IndexHit]: ...


class KeywordIndex(Protocol):
    """BM25 search over chunks. Prototype: ParadeDB pg_search with jieba; product: ES or OpenSearch."""

    name: ClassVar[str]

    async def search(self, text: str, k: int, flt: IndexFilter) -> list[IndexHit]: ...


# ---------------------------------------------------------------- M11 retrieval


class Retriever(Protocol):
    async def search(self, q: SearchQuery, who: Principal) -> SearchResult: ...

    async def answer(self, q: AnswerQuery, who: Principal) -> GroundedAnswer: ...
