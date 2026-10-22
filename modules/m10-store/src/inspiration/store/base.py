"""Reads built on the primitive reads: lineage graphs and DataRef resolution. Shared by
the Postgres and in-memory stores."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from inspiration.contracts import content_hash, kind_of
from inspiration.contracts.interfaces import DataProvider
from inspiration.contracts.models import (
    Claim,
    ClaimDerivation,
    ClaimEvidence,
    ClaimQuery,
    ClaimsData,
    DataColumn,
    DataRef,
    DataTable,
    DependencyEdge,
    InlineData,
    LineageEdge,
    LineageGraph,
    LineageNode,
    LineageRelation,
    PageSnapshot,
    QueryData,
    SourceVersion,
    Span,
)

from .rules import IntegrityError

LABEL_CHARS = 80


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def claim_field(claim: Claim, field: str) -> Any:
    """The value of one ClaimsData column for a claim (see ClaimsData.columns)."""
    v = claim.value
    match field:
        case "claim_id":
            return claim.id
        case "statement":
            return claim.statement
        case "subject":
            return claim.subject_text or claim.subject_entity_id
        case "predicate":
            return claim.predicate
        case "value_number":
            return v.number if v else None
        case "value_text":
            return (v.text or v.normalized) if v else None
        case "value_unit":
            return v.unit if v else None
        case "value_min":
            return v.min if v else None
        case "value_max":
            return v.max if v else None
        case "currency":
            return v.currency if v else None
        case "value_date":
            return v.date.isoformat() if v and v.date else None
        case "valid_from":
            return _iso(claim.valid_time.start)
        case "valid_to":
            return _iso(claim.valid_time.end)
        case "confidence":
            return claim.confidence
        case "status":
            return claim.status.value
        case "knowledge_class":
            return claim.knowledge_class
        case "recorded_at":
            return _iso(claim.recorded_at)
    return None


def rows_hash(columns: Sequence[DataColumn], rows: Sequence[Sequence[Any]]) -> str:
    material = json.dumps([[c.field for c in columns], rows], ensure_ascii=False, sort_keys=True, default=str)
    return content_hash(material)


class BaseStore(ABC):
    """Lineage and resolve_data in terms of the primitive reads each backend implements."""

    data_providers: Mapping[str, DataProvider]
    clock: Callable[[], datetime]

    def __init__(
        self,
        *,
        data_providers: Mapping[str, DataProvider] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.data_providers = dict(data_providers or {})
        self.clock = clock or (lambda: datetime.now(UTC))

    # ---------------------------------------------------------- primitives

    @abstractmethod
    async def get_source_version(self, version_id: str) -> SourceVersion | None: ...

    @abstractmethod
    async def get_spans(self, span_ids: Sequence[str]) -> list[Span]: ...

    @abstractmethod
    async def get_claims(self, claim_ids: Sequence[str]) -> list[Claim]: ...

    @abstractmethod
    async def evidence_of(self, claim_ids: Sequence[str]) -> list[ClaimEvidence]: ...

    @abstractmethod
    async def as_of(
        self, query: ClaimQuery, *, valid_at: datetime | None = None, known_at: datetime | None = None
    ) -> list[Claim]: ...

    @abstractmethod
    async def get_page(self, page_id: str, version: int | None = None) -> PageSnapshot | None: ...

    @abstractmethod
    async def derivations_of(self, claim_ids: Sequence[str]) -> list[ClaimDerivation]: ...

    @abstractmethod
    async def inputs_of(self, artifact_ids: Sequence[str]) -> list[DependencyEdge]: ...

    # ---------------------------------------------------------- lineage

    async def lineage(self, unit_id: str, depth: int = 3) -> LineageGraph:
        """Walk from a unit down to source versions. Edges point from a unit to what it was
        built from, except "contains", which points from a source version to its span."""
        nodes: dict[str, LineageNode] = {}
        edges: list[LineageEdge] = []
        seen_edges: set[tuple[str, str, str]] = set()

        def node(id_: str, label: str | None = None) -> None:
            if id_ not in nodes or (label and not nodes[id_].label):
                nodes[id_] = LineageNode(id=id_, label=label)

        def edge(from_id: str, to_id: str, relation: LineageRelation) -> None:
            key = (from_id, to_id, relation.value)
            if key not in seen_edges:
                seen_edges.add(key)
                edges.append(LineageEdge(from_id=from_id, to_id=to_id, relation=relation))

        node(unit_id)
        frontier = [unit_id]
        expanded: set[str] = set()
        for _ in range(depth):
            if not frontier:
                break
            by_kind: dict[str, list[str]] = {}
            for id_ in frontier:
                expanded.add(id_)
                by_kind.setdefault(kind_of(id_), []).append(id_)
            nxt: list[str] = []

            claim_ids = by_kind.pop("claim", [])
            span_ids = by_kind.pop("span", [])
            version_ids = by_kind.pop("source_version", [])
            others = [i for ids in by_kind.values() for i in ids]  # pages, SOPs, views, ...

            if claim_ids:
                for c in await self.get_claims(claim_ids):
                    node(c.id, c.statement[:LABEL_CHARS])
                    if c.superseded_by:
                        node(c.superseded_by)
                        edge(c.superseded_by, c.id, LineageRelation.supersedes)
                for e in await self.evidence_of(claim_ids):
                    node(e.span_id)
                    edge(e.claim_id, e.span_id, LineageRelation.cites)
                    nxt.append(e.span_id)
                for d in await self.derivations_of(claim_ids):
                    for f in d.from_claim_ids:
                        node(f)
                        edge(d.claim_id, f, LineageRelation.derived_from)
                        nxt.append(f)

            for s in await self.get_spans(span_ids) if span_ids else []:
                node(s.id, s.text[:LABEL_CHARS])
                node(s.source_version_id)
                edge(s.source_version_id, s.id, LineageRelation.contains)
                nxt.append(s.source_version_id)

            for sv_id in version_ids:
                if (sv := await self.get_source_version(sv_id)) is not None:
                    node(sv.id, sv.title)

            for page_id in by_kind.get("page", []):
                if (page := await self.get_page(page_id)) is not None:
                    node(page_id, page.spec.title)

            if claim_ids or others:
                for dep in await self.inputs_of([*claim_ids, *others]):
                    node(dep.input_id)
                    edge(dep.artifact_id, dep.input_id, LineageRelation.depends_on)
                    nxt.append(dep.input_id)

            frontier = [i for i in dict.fromkeys(nxt) if i not in expanded]

        # Source versions are leaves; anything else left unexpanded may have more provenance.
        truncated = any(kind_of(i) != "source_version" for i in frontier)
        for sv_id in [i for i in frontier if kind_of(i) == "source_version"]:
            if (sv := await self.get_source_version(sv_id)) is not None:
                node(sv.id, sv.title)
        return LineageGraph(root_id=unit_id, nodes=list(nodes.values()), edges=edges, truncated=truncated)

    # ---------------------------------------------------------- DataRef

    async def resolve_data(self, ref: DataRef) -> DataTable:
        now = self.clock()
        if isinstance(ref, InlineData):
            return DataTable(
                columns=ref.columns,
                rows=ref.rows,
                row_claim_ids=ref.row_claim_ids,
                resolved_at=now,
                snapshot_hash=rows_hash(ref.columns, ref.rows),
            )
        if isinstance(ref, ClaimsData):
            if ref.claim_ids:
                found = {c.id: c for c in await self.get_claims(ref.claim_ids)}
                claims = [found[i] for i in ref.claim_ids if i in found]
            elif ref.query is not None:
                claims = await self.as_of(ref.query)
            else:
                raise IntegrityError("claims data needs claim_ids or a query")
            rows = [[claim_field(c, col.field) for col in ref.columns] for c in claims]
            return DataTable(
                columns=ref.columns,
                rows=rows,
                row_claim_ids=[[c.id] for c in claims],
                resolved_at=now,
                snapshot_hash=rows_hash(ref.columns, rows),
            )
        if isinstance(ref, QueryData):
            provider = self.data_providers.get(ref.provider)
            if provider is None:
                raise LookupError(f"no data provider {ref.provider!r} is configured")
            table = await provider.run(ref.query_id, ref.params or {}, ref.columns)
            if [c.field for c in table.columns] != [c.field for c in ref.columns]:
                raise IntegrityError(f"data provider {ref.provider} returned other columns than requested")
            if table.snapshot_hash is None:
                table = table.model_copy(update={"snapshot_hash": rows_hash(table.columns, table.rows)})
            return table
        raise TypeError(f"unknown DataRef {type(ref).__name__}")
