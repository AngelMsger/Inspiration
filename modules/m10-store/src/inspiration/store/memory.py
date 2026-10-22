"""In-memory KnowledgeStore for module tests. Same rules and same results as Postgres; a
transaction works on a copy of the state and swaps it in on commit."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime

from inspiration.contracts.interfaces import DataProvider, EventPublisher
from inspiration.contracts.models import (
    AclSnapshot,
    Chunk,
    Claim,
    ClaimDerivation,
    ClaimEvidence,
    ClaimQuery,
    ClaimStatus,
    DependencyEdge,
    EventEnvelope,
    EvidenceRole,
    PageSnapshot,
    PageVersionInfo,
    SourceVersion,
    Span,
)

from . import rules
from .base import BaseStore
from .query import matches


@dataclass
class _State:
    versions: dict[str, SourceVersion] = field(default_factory=dict)
    spans: dict[str, Span] = field(default_factory=dict)
    chunks: dict[str, Chunk] = field(default_factory=dict)
    embeddings: dict[str, tuple[str, list[float]]] = field(default_factory=dict)
    claims: dict[str, Claim] = field(default_factory=dict)
    supersede_reasons: dict[str, str] = field(default_factory=dict)
    evidence: dict[tuple[str, str, str], ClaimEvidence] = field(default_factory=dict)
    derivations: dict[str, ClaimDerivation] = field(default_factory=dict)
    dependencies: dict[tuple[str, str], DependencyEdge] = field(default_factory=dict)
    pages: dict[str, dict[int, PageSnapshot]] = field(default_factory=dict)
    acls: dict[tuple[str, str, str], AclSnapshot] = field(default_factory=dict)

    def copy(self) -> _State:
        # Values are replaced, never mutated, so copying the containers is enough.
        return _State(**{k: copy.copy(v) for k, v in self.__dict__.items()})


class MemoryTx:
    def __init__(self, store: MemoryStore, state: _State) -> None:
        self.store = store
        self.s = state
        self.events: list[EventEnvelope] = []

    async def put_source_version(self, version: SourceVersion, spans: Sequence[Span]) -> None:
        rules.check_source_version(version, spans)
        self.s.versions.setdefault(version.id, version)
        for sp in spans:
            self.s.spans.setdefault(sp.id, sp)

    async def put_chunks(
        self,
        chunks: Sequence[Chunk],
        embeddings: Mapping[str, Sequence[float]] | None = None,
        *,
        model: str | None = None,
    ) -> None:
        rules.check_chunks(chunks, self.s.versions.keys(), embeddings, model)
        for c in chunks:
            self.s.chunks[c.id] = c
        for chunk_id, vector in (embeddings or {}).items():
            assert model is not None
            self.s.embeddings[chunk_id] = (model, [float(x) for x in vector])

    async def put_embeddings(self, items: Mapping[str, Sequence[float]], *, model: str) -> None:
        rules.check_chunks([self.s.chunks[i] for i in items if i in self.s.chunks], self.s.versions, items, model)
        for chunk_id, vector in items.items():
            self.s.embeddings[chunk_id] = (model, [float(x) for x in vector])

    async def remove_chunks(self, chunk_ids: Sequence[str]) -> None:
        for i in chunk_ids:
            self.s.chunks.pop(i, None)
            self.s.embeddings.pop(i, None)

    async def upsert_claims(
        self,
        claims: Sequence[Claim],
        evidence: Sequence[ClaimEvidence],
        derivations: Sequence[ClaimDerivation] = (),
    ) -> list[str]:
        referenced = {e.claim_id for e in evidence} | {d.claim_id for d in derivations}
        referenced |= {f for d in derivations for f in d.from_claim_ids} | {c.id for c in claims}
        existing = {i for i in referenced if i in self.s.claims}
        supported = {
            c.id
            for c in claims
            if c.id in self.s.derivations
            or any(k[0] == c.id and k[2] == EvidenceRole.supports.value for k in self.s.evidence)
        }
        rules.check_claims(claims, evidence, derivations, existing=existing, already_supported=supported)
        for e in evidence:
            rules.check_evidence(e, self.s.spans.get(e.span_id))
        for c in claims:
            self.s.claims[c.id] = c
        for d in derivations:
            self.s.derivations[d.claim_id] = d
        for e in evidence:
            self.s.evidence[(e.claim_id, e.span_id, e.role.value)] = e
        return [c.id for c in claims]

    async def supersede(self, claim_id: str, by: str, reason: str) -> None:
        old, new = self.s.claims.get(claim_id), self.s.claims.get(by)
        rules.check_supersede(old, new, claim_id, by)
        assert old is not None
        now = self.store.clock()
        self.s.claims[claim_id] = old.model_copy(
            update={"superseded_at": now, "superseded_by": by, "status": ClaimStatus.superseded, "updated_at": now}
        )
        self.s.supersede_reasons[claim_id] = reason

    async def record_dependencies(self, edges: Sequence[DependencyEdge]) -> None:
        artifacts = {e.artifact_id for e in edges}
        for key in [k for k in self.s.dependencies if k[0] in artifacts]:
            del self.s.dependencies[key]
        for e in edges:
            self.s.dependencies[(e.artifact_id, e.input_id)] = e

    async def put_page_snapshot(self, snapshot: PageSnapshot) -> None:
        versions = self.s.pages.get(snapshot.page_id, {})
        rules.check_page_snapshot(snapshot, max(versions) if versions else None)
        self.s.pages[snapshot.page_id] = {**versions, snapshot.version: snapshot}

    async def put_acl_snapshot(self, snapshot: AclSnapshot) -> None:
        self.s.acls.setdefault((snapshot.source_id, snapshot.external_id, snapshot.acl_hash), snapshot)

    async def publish(self, *events: EventEnvelope) -> None:
        self.events.extend(events)


class MemoryStore(BaseStore):
    def __init__(
        self,
        *,
        publisher: EventPublisher | None = None,
        data_providers: Mapping[str, DataProvider] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        super().__init__(data_providers=data_providers, clock=clock)
        self.state = _State()
        self.publisher = publisher
        self.published: list[EventEnvelope] = []  # events from committed transactions, in order
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[MemoryTx]:
        async with self._lock:
            tx = MemoryTx(self, self.state.copy())
            yield tx
            self.state = tx.s
            self.published.extend(tx.events)
        if self.publisher is not None and tx.events:
            await self.publisher.publish(*tx.events)

    # ---------------------------------------------------------- reads

    async def get_source_version(self, version_id: str) -> SourceVersion | None:
        return self.state.versions.get(version_id)

    async def latest_source_version(self, source_id: str, external_id: str) -> SourceVersion | None:
        versions = [v for v in self.state.versions.values() if (v.source_id, v.external_id) == (source_id, external_id)]
        return max(versions, key=lambda v: (v.fetched_at, v.id), default=None)

    async def get_spans(self, span_ids: Sequence[str]) -> list[Span]:
        return [self.state.spans[i] for i in span_ids if i in self.state.spans]

    async def spans_of(self, source_version_id: str) -> list[Span]:
        spans = [s for s in self.state.spans.values() if s.source_version_id == source_version_id]
        return sorted(spans, key=lambda s: s.ordinal)

    async def get_chunks(self, chunk_ids: Sequence[str]) -> list[Chunk]:
        return [self.state.chunks[i] for i in chunk_ids if i in self.state.chunks]

    async def chunks_of(self, source_version_id: str) -> list[Chunk]:
        chunks = [c for c in self.state.chunks.values() if c.source_version_id == source_version_id]
        return sorted(chunks, key=lambda c: c.ordinal)

    async def get_claims(self, claim_ids: Sequence[str]) -> list[Claim]:
        return [self.state.claims[i] for i in claim_ids if i in self.state.claims]

    async def evidence_of(self, claim_ids: Sequence[str]) -> list[ClaimEvidence]:
        wanted = set(claim_ids)
        return [e for k, e in sorted(self.state.evidence.items()) if k[0] in wanted]

    async def claims_citing(self, span_ids: Sequence[str]) -> list[str]:
        wanted = set(span_ids)
        return sorted({k[0] for k in self.state.evidence if k[1] in wanted})

    async def as_of(
        self, query: ClaimQuery, *, valid_at: datetime | None = None, known_at: datetime | None = None
    ) -> list[Claim]:
        known = known_at or self.clock()
        with_evidence_in: set[str] | None = None
        if query.source_version_ids:
            versions = set(query.source_version_ids)
            with_evidence_in = {e.claim_id for e in self.state.evidence.values() if e.source_version_id in versions}
        out = [
            c
            for c in self.state.claims.values()
            if matches(c, query, valid_at=valid_at, known_at=known)
            and (with_evidence_in is None or c.id in with_evidence_in)
        ]
        out.sort(key=lambda c: (c.recorded_at, c.id))
        return out[: query.limit or 1000]

    async def dependents(self, artifact_ids: Sequence[str]) -> list[str]:
        wanted = set(artifact_ids)
        return sorted({k[0] for k in self.state.dependencies if k[1] in wanted})

    async def derivations_of(self, claim_ids: Sequence[str]) -> list[ClaimDerivation]:
        return [self.state.derivations[i] for i in claim_ids if i in self.state.derivations]

    async def inputs_of(self, artifact_ids: Sequence[str]) -> list[DependencyEdge]:
        wanted = set(artifact_ids)
        return [e for k, e in sorted(self.state.dependencies.items()) if k[0] in wanted]

    async def get_page(self, page_id: str, version: int | None = None) -> PageSnapshot | None:
        versions = self.state.pages.get(page_id)
        if not versions:
            return None
        return versions.get(version if version is not None else max(versions))

    async def page_history(self, page_id: str) -> list[PageVersionInfo]:
        versions = self.state.pages.get(page_id, {})
        return [
            PageVersionInfo(
                page_id=p.page_id,
                version=p.version,
                inputs_hash=p.spec.inputs_hash,
                cause=p.cause,
                change_summary=p.change_summary,
                created_at=p.created_at,
            )
            for _, p in sorted(versions.items())
        ]

    async def get_acl_snapshot(
        self, source_id: str, external_id: str, acl_hash: str | None = None
    ) -> AclSnapshot | None:
        if acl_hash is not None:
            return self.state.acls.get((source_id, external_id, acl_hash))
        found = [a for k, a in self.state.acls.items() if k[:2] == (source_id, external_id)]
        return max(found, key=lambda a: (a.captured_at, a.acl_hash), default=None)

    def embedding_of(self, chunk_id: str) -> tuple[str, list[float]] | None:
        return self.state.embeddings.get(chunk_id)
