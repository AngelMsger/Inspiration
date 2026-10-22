"""Postgres KnowledgeStore. Events published in a transaction go to the outbox in the same
transaction, so they commit (or roll back) with the data."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import psycopg
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from inspiration.contracts.interfaces import DataProvider
from inspiration.contracts.labels import rank
from inspiration.contracts.models import (
    Chunk,
    Claim,
    ClaimDerivation,
    ClaimEvidence,
    ClaimQuery,
    ClaimStatus,
    DependencyEdge,
    EventEnvelope,
    PageSnapshot,
    PageVersionInfo,
    SourceVersion,
    Span,
)
from inspiration.eventbus import write_outbox

from . import rules
from .base import BaseStore
from .query import to_sql


def _doc(model: Any) -> Jsonb:
    return Jsonb(model.model_dump(mode="json", exclude_none=True))


def search_text(c: Chunk) -> str:
    """What BM25 indexes: the contextual header and heading path situate the chunk text."""
    return "\n".join(p for p in (c.contextual_header, " / ".join(c.heading_path or []), c.text) if p)


def vector_literal(v: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


async def fetch_dicts(conn: AsyncConnection[Any], sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    cur = await conn.execute(sql, params)
    rows = await cur.fetchall()
    return [
        r if isinstance(r, dict) else dict(zip([d.name for d in cur.description or []], r, strict=True)) for r in rows
    ]


async def write_embeddings(conn: AsyncConnection[Any], items: Mapping[str, Sequence[float]], *, model: str) -> None:
    """Upsert embeddings of stored chunks. Unknown chunk IDs raise IntegrityError."""
    if not items:
        return
    sizes = {len(v) for v in items.values()}
    if len(sizes) != 1 or 0 in sizes:
        raise rules.IntegrityError("embeddings in one write must share one non-zero size")
    try:
        async with conn.cursor() as cur:
            await cur.executemany(
                """INSERT INTO kb.chunk_embeddings (chunk_id, model, dims, embedding)
                   VALUES (%s, %s, %s, %s::vector)
                   ON CONFLICT (chunk_id) DO UPDATE
                     SET model = excluded.model, dims = excluded.dims, embedding = excluded.embedding""",
                [(chunk_id, model, len(v), vector_literal(v)) for chunk_id, v in items.items()],
            )
    except psycopg.errors.ForeignKeyViolation as e:
        raise rules.IntegrityError("embeddings for unknown chunks") from e


class PgTx:
    def __init__(self, store: PostgresStore, conn: AsyncConnection[Any]) -> None:
        self.store = store
        self.conn = conn

    async def put_source_version(self, version: SourceVersion, spans: Sequence[Span]) -> None:
        rules.check_source_version(version, spans)
        await self.conn.execute(
            """INSERT INTO kb.source_versions
               (id, tenant_id, source_id, space_id, external_id, fetched_at, deleted, sensitivity, doc)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING""",
            (
                version.id,
                version.tenant_id,
                version.source_id,
                version.space_id,
                version.external_id,
                version.fetched_at,
                bool(version.deleted),
                version.sensitivity.value,
                _doc(version),
            ),
        )
        if spans:
            async with self.conn.cursor() as cur:
                await cur.executemany(
                    """INSERT INTO kb.spans (id, tenant_id, source_version_id, ordinal, text, doc)
                       VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING""",
                    [(s.id, s.tenant_id, s.source_version_id, s.ordinal, s.text, _doc(s)) for s in spans],
                )

    async def put_chunks(
        self,
        chunks: Sequence[Chunk],
        embeddings: Mapping[str, Sequence[float]] | None = None,
        *,
        model: str | None = None,
    ) -> None:
        version_ids = sorted({c.source_version_id for c in chunks})
        rows = await fetch_dicts(self.conn, "SELECT id FROM kb.source_versions WHERE id = ANY(%s)", (version_ids,))
        rules.check_chunks(chunks, {r["id"] for r in rows}, embeddings, model)
        if chunks:
            async with self.conn.cursor() as cur:
                await cur.executemany(
                    """INSERT INTO kb.chunks
                       (id, tenant_id, source_version_id, space_id, ordinal, search_text, sensitivity_rank,
                        acl_tokens, doc)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, ordinal = excluded.ordinal,
                         search_text = excluded.search_text, sensitivity_rank = excluded.sensitivity_rank,
                         acl_tokens = excluded.acl_tokens, doc = excluded.doc""",
                    [
                        (
                            c.id,
                            c.tenant_id,
                            c.source_version_id,
                            c.space_id,
                            c.ordinal,
                            search_text(c),
                            rank(c.sensitivity),
                            list(c.acl_tokens or []),
                            _doc(c),
                        )
                        for c in chunks
                    ],
                )
        if embeddings:
            assert model is not None
            await self.put_embeddings(embeddings, model=model)

    async def put_embeddings(self, items: Mapping[str, Sequence[float]], *, model: str) -> None:
        await write_embeddings(self.conn, items, model=model)

    async def remove_chunks(self, chunk_ids: Sequence[str]) -> None:
        await self.conn.execute("DELETE FROM kb.chunks WHERE id = ANY(%s)", (list(chunk_ids),))

    async def upsert_claims(
        self,
        claims: Sequence[Claim],
        evidence: Sequence[ClaimEvidence],
        derivations: Sequence[ClaimDerivation] = (),
    ) -> list[str]:
        referenced = {e.claim_id for e in evidence} | {d.claim_id for d in derivations}
        referenced |= {f for d in derivations for f in d.from_claim_ids} | {c.id for c in claims}
        ids = sorted(referenced)
        existing = {
            r["id"] for r in await fetch_dicts(self.conn, "SELECT id FROM kb.claims WHERE id = ANY(%s)", (ids,))
        }
        batch = [c.id for c in claims]
        supported = {
            r["claim_id"]
            for r in await fetch_dicts(
                self.conn,
                """SELECT claim_id FROM kb.claim_evidence WHERE claim_id = ANY(%s) AND role = 'supports'
                   UNION SELECT claim_id FROM kb.claim_derivations WHERE claim_id = ANY(%s)""",
                (batch, batch),
            )
        }
        rules.check_claims(claims, evidence, derivations, existing=existing, already_supported=supported)
        spans = {s.id: s for s in await self._spans(sorted({e.span_id for e in evidence}))}
        for e in evidence:
            rules.check_evidence(e, spans.get(e.span_id))

        async with self.conn.cursor() as cur:
            if claims:
                await cur.executemany(
                    """INSERT INTO kb.claims
                       (id, tenant_id, space_id, status, knowledge_class, subject_entity_id, predicate,
                        valid_from, valid_to, recorded_at, superseded_at, superseded_by, sensitivity, doc)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, status = excluded.status,
                         knowledge_class = excluded.knowledge_class, subject_entity_id = excluded.subject_entity_id,
                         predicate = excluded.predicate, valid_from = excluded.valid_from,
                         valid_to = excluded.valid_to, recorded_at = excluded.recorded_at,
                         superseded_at = excluded.superseded_at, superseded_by = excluded.superseded_by,
                         sensitivity = excluded.sensitivity, doc = excluded.doc""",
                    [
                        (
                            c.id,
                            c.tenant_id,
                            c.space_id,
                            c.status.value,
                            c.knowledge_class,
                            c.subject_entity_id,
                            c.predicate,
                            c.valid_time.start,
                            c.valid_time.end,
                            c.recorded_at,
                            c.superseded_at,
                            c.superseded_by,
                            c.sensitivity.value,
                            _doc(c),
                        )
                        for c in claims
                    ],
                )
            if derivations:
                await cur.executemany(
                    """INSERT INTO kb.claim_derivations (claim_id, from_claim_ids, method) VALUES (%s, %s, %s)
                       ON CONFLICT (claim_id) DO UPDATE
                         SET from_claim_ids = excluded.from_claim_ids, method = excluded.method""",
                    [(d.claim_id, list(d.from_claim_ids), d.method.value) for d in derivations],
                )
            if evidence:
                await cur.executemany(
                    """INSERT INTO kb.claim_evidence (claim_id, span_id, source_version_id, role, doc)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (claim_id, span_id, role) DO UPDATE SET doc = excluded.doc""",
                    [(e.claim_id, e.span_id, e.source_version_id, e.role.value, _doc(e)) for e in evidence],
                )
        return batch

    async def supersede(self, claim_id: str, by: str, reason: str) -> None:
        rows = await fetch_dicts(
            self.conn, "SELECT id, doc FROM kb.claims WHERE id = ANY(%s) FOR UPDATE", ([claim_id, by],)
        )
        found = {r["id"]: Claim.model_validate(r["doc"]) for r in rows}
        rules.check_supersede(found.get(claim_id), found.get(by), claim_id, by)
        now = self.store.clock()
        updated = found[claim_id].model_copy(
            update={"superseded_at": now, "superseded_by": by, "status": ClaimStatus.superseded, "updated_at": now}
        )
        await self.conn.execute(
            """UPDATE kb.claims SET superseded_at = %s, superseded_by = %s, status = 'superseded',
                 supersede_reason = %s, doc = %s WHERE id = %s""",
            (now, by, reason, _doc(updated), claim_id),
        )

    async def record_dependencies(self, edges: Sequence[DependencyEdge]) -> None:
        artifacts = sorted({e.artifact_id for e in edges})
        await self.conn.execute("DELETE FROM kb.dependencies WHERE artifact_id = ANY(%s)", (artifacts,))
        if edges:
            async with self.conn.cursor() as cur:
                await cur.executemany(
                    "INSERT INTO kb.dependencies (artifact_id, input_id, input_hash) VALUES (%s, %s, %s)",
                    [(e.artifact_id, e.input_id, e.input_hash) for e in edges],
                )

    async def put_page_snapshot(self, snapshot: PageSnapshot) -> None:
        # Serialize writers of one page so two renders cannot both claim the next version.
        await self.conn.execute("SELECT pg_advisory_xact_lock(hashtext('kb.page:' || %s))", (snapshot.page_id,))
        rows = await fetch_dicts(
            self.conn, "SELECT max(version) AS v FROM kb.page_snapshots WHERE page_id = %s", (snapshot.page_id,)
        )
        rules.check_page_snapshot(snapshot, rows[0]["v"] if rows else None)
        spec = snapshot.spec
        await self.conn.execute(
            """INSERT INTO kb.page_snapshots (page_id, version, tenant_id, space_id, inputs_hash, created_at, doc)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                snapshot.page_id,
                snapshot.version,
                spec.tenant_id,
                spec.space_id,
                spec.inputs_hash,
                snapshot.created_at,
                _doc(snapshot),
            ),
        )

    async def publish(self, *events: EventEnvelope) -> None:
        await write_outbox(self.conn, events)

    async def _spans(self, span_ids: Sequence[str]) -> list[Span]:
        rows = await fetch_dicts(self.conn, "SELECT doc FROM kb.spans WHERE id = ANY(%s)", (list(span_ids),))
        return [Span.model_validate(r["doc"]) for r in rows]


class PostgresStore(BaseStore):
    def __init__(
        self,
        pool: AsyncConnectionPool[Any],
        *,
        data_providers: Mapping[str, DataProvider] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        super().__init__(data_providers=data_providers, clock=clock)
        self.pool = pool

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[PgTx]:
        async with self.pool.connection() as conn, conn.transaction():
            try:
                yield PgTx(self, conn)
            except psycopg.errors.UniqueViolation as e:
                raise rules.IntegrityError(str(e).splitlines()[0]) from e
            except psycopg.errors.ForeignKeyViolation as e:
                raise rules.IntegrityError(str(e).splitlines()[0]) from e

    async def _rows(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            return await fetch_dicts(conn, sql, params)

    async def _docs[M: BaseModel](self, model: type[M], sql: str, params: Sequence[Any] = ()) -> list[M]:
        return [model.model_validate(r["doc"]) for r in await self._rows(sql, params)]

    # ---------------------------------------------------------- reads

    async def get_source_version(self, version_id: str) -> SourceVersion | None:
        found = await self._docs(SourceVersion, "SELECT doc FROM kb.source_versions WHERE id = %s", (version_id,))
        return found[0] if found else None

    async def latest_source_version(self, source_id: str, external_id: str) -> SourceVersion | None:
        found = await self._docs(
            SourceVersion,
            """SELECT doc FROM kb.source_versions WHERE source_id = %s AND external_id = %s
               ORDER BY fetched_at DESC, id DESC LIMIT 1""",
            (source_id, external_id),
        )
        return found[0] if found else None

    async def get_spans(self, span_ids: Sequence[str]) -> list[Span]:
        found = {
            s.id: s for s in await self._docs(Span, "SELECT doc FROM kb.spans WHERE id = ANY(%s)", (list(span_ids),))
        }
        return [found[i] for i in span_ids if i in found]

    async def spans_of(self, source_version_id: str) -> list[Span]:
        return await self._docs(
            Span, "SELECT doc FROM kb.spans WHERE source_version_id = %s ORDER BY ordinal", (source_version_id,)
        )

    async def get_chunks(self, chunk_ids: Sequence[str]) -> list[Chunk]:
        found = {
            c.id: c for c in await self._docs(Chunk, "SELECT doc FROM kb.chunks WHERE id = ANY(%s)", (list(chunk_ids),))
        }
        return [found[i] for i in chunk_ids if i in found]

    async def chunks_of(self, source_version_id: str) -> list[Chunk]:
        return await self._docs(
            Chunk, "SELECT doc FROM kb.chunks WHERE source_version_id = %s ORDER BY ordinal", (source_version_id,)
        )

    async def get_claims(self, claim_ids: Sequence[str]) -> list[Claim]:
        found = {
            c.id: c for c in await self._docs(Claim, "SELECT doc FROM kb.claims WHERE id = ANY(%s)", (list(claim_ids),))
        }
        return [found[i] for i in claim_ids if i in found]

    async def evidence_of(self, claim_ids: Sequence[str]) -> list[ClaimEvidence]:
        return await self._docs(
            ClaimEvidence,
            "SELECT doc FROM kb.claim_evidence WHERE claim_id = ANY(%s) ORDER BY claim_id, span_id, role",
            (list(claim_ids),),
        )

    async def claims_citing(self, span_ids: Sequence[str]) -> list[str]:
        rows = await self._rows(
            "SELECT DISTINCT claim_id FROM kb.claim_evidence WHERE span_id = ANY(%s) ORDER BY claim_id",
            (list(span_ids),),
        )
        return [r["claim_id"] for r in rows]

    async def as_of(
        self, query: ClaimQuery, *, valid_at: datetime | None = None, known_at: datetime | None = None
    ) -> list[Claim]:
        where, params = to_sql(query, valid_at=valid_at, known_at=known_at or self.clock())
        return await self._docs(
            Claim,
            f"SELECT c.doc FROM kb.claims c WHERE {where} ORDER BY c.recorded_at, c.id LIMIT %s",
            [*params, query.limit or 1000],
        )

    async def dependents(self, artifact_ids: Sequence[str]) -> list[str]:
        rows = await self._rows(
            "SELECT DISTINCT artifact_id FROM kb.dependencies WHERE input_id = ANY(%s) ORDER BY artifact_id",
            (list(artifact_ids),),
        )
        return [r["artifact_id"] for r in rows]

    async def derivations_of(self, claim_ids: Sequence[str]) -> list[ClaimDerivation]:
        rows = await self._rows(
            "SELECT claim_id, from_claim_ids, method FROM kb.claim_derivations WHERE claim_id = ANY(%s)",
            (list(claim_ids),),
        )
        return [ClaimDerivation.model_validate(r) for r in rows]

    async def inputs_of(self, artifact_ids: Sequence[str]) -> list[DependencyEdge]:
        rows = await self._rows(
            """SELECT artifact_id, input_id, input_hash FROM kb.dependencies WHERE artifact_id = ANY(%s)
               ORDER BY artifact_id, input_id""",
            (list(artifact_ids),),
        )
        return [DependencyEdge.model_validate(r) for r in rows]

    async def get_page(self, page_id: str, version: int | None = None) -> PageSnapshot | None:
        sql = "SELECT doc FROM kb.page_snapshots WHERE page_id = %s"
        params: list[Any] = [page_id]
        if version is None:
            sql += " ORDER BY version DESC LIMIT 1"
        else:
            sql += " AND version = %s"
            params.append(version)
        found = await self._docs(PageSnapshot, sql, params)
        return found[0] if found else None

    async def page_history(self, page_id: str) -> list[PageVersionInfo]:
        rows = await self._rows(
            """SELECT page_id, version, inputs_hash, doc->'cause' AS cause, doc->>'change_summary' AS change_summary,
                      created_at
               FROM kb.page_snapshots WHERE page_id = %s ORDER BY version""",
            (page_id,),
        )
        return [PageVersionInfo.model_validate({k: v for k, v in r.items() if v is not None}) for r in rows]
