"""Search index plugins over kb.chunks. Every search applies the IndexFilter inside the
index query (space, ACL token overlap, sensitivity), so top-k is taken over rows the
viewer may see. Retrieval still re-checks results before they leave the server."""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any, ClassVar

from psycopg_pool import AsyncConnectionPool

from inspiration.contracts.labels import rank
from inspiration.contracts.models import Chunk, IndexFilter, IndexHit

from .memory import MemoryStore
from .postgres import fetch_dicts, search_text, vector_literal, write_embeddings

HNSW_DIMS = 1024  # the size the partial HNSW index in 0001_kb.sql covers


def _hits(scored: Sequence[tuple[str, float]], k: int) -> list[IndexHit]:
    ordered = sorted(scored, key=lambda x: (-x[1], x[0]))[:k]
    return [IndexHit(chunk_id=i, score=s, rank=n) for n, (i, s) in enumerate(ordered, start=1)]


def _empty(flt: IndexFilter) -> bool:
    return not flt.space_ids or not flt.principal_tokens


class PgVectorIndex:
    """pgvector over kb.chunk_embeddings, cosine similarity. Pass model to keep searches
    from mixing vectors of different embedding models."""

    name: ClassVar[str] = "pgvector"

    def __init__(self, pool: AsyncConnectionPool[Any], *, model: str | None = None, ef_search: int = 100) -> None:
        self.pool = pool
        self.model = model
        self.ef_search = ef_search

    async def upsert(self, items: Mapping[str, Sequence[float]], *, model: str) -> None:
        async with self.pool.connection() as conn, conn.transaction():
            await write_embeddings(conn, items, model=model)

    async def delete(self, chunk_ids: Sequence[str]) -> None:
        async with self.pool.connection() as conn:
            await conn.execute("DELETE FROM kb.chunk_embeddings WHERE chunk_id = ANY(%s)", (list(chunk_ids),))

    async def search(self, vector: Sequence[float], k: int, flt: IndexFilter) -> list[IndexHit]:
        if _empty(flt) or not vector:
            return []
        dims = len(vector)
        # The cast must match the partial index expression for the planner to use HNSW.
        expr = f"e.embedding::vector({HNSW_DIMS})" if dims == HNSW_DIMS else "e.embedding"
        cast = f"::vector({HNSW_DIMS})" if dims == HNSW_DIMS else "::vector"
        where = ["e.dims = %s", "c.space_id = ANY(%s)", "c.acl_tokens && %s", "c.sensitivity_rank <= %s"]
        params: list[Any] = [dims, list(flt.space_ids), list(flt.principal_tokens), rank(flt.max_sensitivity)]
        if self.model:
            where.append("e.model = %s")
            params.append(self.model)
        literal = vector_literal(vector)
        sql = f"""SELECT c.id, 1 - ({expr} <=> %s{cast}) AS score
                  FROM kb.chunk_embeddings e JOIN kb.chunks c ON c.id = e.chunk_id
                  WHERE {" AND ".join(where)}
                  ORDER BY {expr} <=> %s{cast} LIMIT %s"""
        async with self.pool.connection() as conn, conn.transaction():
            # Keep scanning the HNSW graph until k rows pass the filter (pgvector 0.8).
            await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
            await conn.execute(f"SET LOCAL hnsw.ef_search = {int(self.ef_search)}")
            rows = await fetch_dicts(conn, sql, [literal, *params, literal, k])
        return _hits([(r["id"], float(r["score"])) for r in rows], k)


class PgSearchIndex:
    """BM25 over kb.chunks.search_text through ParadeDB pg_search with the jieba tokenizer."""

    name: ClassVar[str] = "pg_search"

    def __init__(self, pool: AsyncConnectionPool[Any]) -> None:
        self.pool = pool

    async def search(self, text: str, k: int, flt: IndexFilter) -> list[IndexHit]:
        if _empty(flt) or not text.strip():
            return []
        sql = """SELECT id, pdb.score(id) AS score FROM kb.chunks
                 WHERE search_text ||| %s AND space_id = ANY(%s) AND sensitivity_rank <= %s AND acl_tokens && %s
                 ORDER BY pdb.score(id) DESC LIMIT %s"""
        params = [text, list(flt.space_ids), rank(flt.max_sensitivity), list(flt.principal_tokens), k]
        async with self.pool.connection() as conn:
            rows = await fetch_dicts(conn, sql, params)
        return _hits([(r["id"], float(r["score"])) for r in rows], k)


# ---------------------------------------------------------------- in memory


def _visible(c: Chunk, flt: IndexFilter) -> bool:
    return (
        c.space_id in flt.space_ids
        and bool(set(c.acl_tokens or []) & set(flt.principal_tokens))
        and rank(c.sensitivity) <= rank(flt.max_sensitivity)
    )


_WORD = re.compile(r"[0-9a-z]+|[㐀-鿿]")


def terms(text: str) -> list[str]:
    """Latin words plus CJK unigrams and bigrams: a crude stand-in for jieba."""
    tokens = _WORD.findall(text.lower())
    cjk = [t for t in tokens if len(t) == 1 and "㐀" <= t <= "鿿"]
    return tokens + [a + b for a, b in itertools.pairwise(cjk)]


class MemoryVectorIndex:
    name: ClassVar[str] = "memory"

    def __init__(self, store: MemoryStore, *, model: str | None = None) -> None:
        self.store = store
        self.model = model

    async def upsert(self, items: Mapping[str, Sequence[float]], *, model: str) -> None:
        async with self.store.transaction() as tx:
            await tx.put_embeddings(items, model=model)

    async def delete(self, chunk_ids: Sequence[str]) -> None:
        async with self.store.transaction() as tx:
            for i in chunk_ids:
                tx.s.embeddings.pop(i, None)

    async def search(self, vector: Sequence[float], k: int, flt: IndexFilter) -> list[IndexHit]:
        norm = math.sqrt(sum(x * x for x in vector)) or 1.0
        scored = []
        for chunk_id, (model, v) in self.store.state.embeddings.items():
            chunk = self.store.state.chunks.get(chunk_id)
            if chunk is None or len(v) != len(vector) or not _visible(chunk, flt):
                continue
            if self.model and model != self.model:
                continue
            vnorm = math.sqrt(sum(x * x for x in v)) or 1.0
            scored.append((chunk_id, sum(a * b for a, b in zip(vector, v, strict=True)) / (norm * vnorm)))
        return _hits(scored, k)


class MemoryKeywordIndex:
    """BM25 (k1=1.2, b=0.75) over the same search text Postgres indexes."""

    name: ClassVar[str] = "memory"

    def __init__(self, store: MemoryStore) -> None:
        self.store = store

    async def search(self, text: str, k: int, flt: IndexFilter) -> list[IndexHit]:
        query = set(terms(text))
        if not query:
            return []
        docs = {c.id: Counter(terms(search_text(c))) for c in self.store.state.chunks.values() if _visible(c, flt)}
        if not docs:
            return []
        avg = sum(sum(d.values()) for d in docs.values()) / len(docs)
        scored = []
        for chunk_id, tf in docs.items():
            length = sum(tf.values())
            score = 0.0
            for t in query & tf.keys():
                df = sum(1 for d in docs.values() if t in d)
                idf = math.log(1 + (len(docs) - df + 0.5) / (df + 0.5))
                score += idf * tf[t] * 2.2 / (tf[t] + 1.2 * (0.25 + 0.75 * length / avg))
            if score > 0:
                scored.append((chunk_id, score))
        return _hits(scored, k)
