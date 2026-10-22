"""Search index plugins: the same filter semantics for pgvector/pg_search and the in-memory
stand-ins that other modules' tests use."""

from __future__ import annotations

import itertools
import math
from collections.abc import AsyncIterator
from typing import Any

import pytest

from inspiration.contracts.interfaces import KeywordIndex, VectorIndex
from inspiration.contracts.models import IndexFilter, SensitivityLabel
from inspiration.kernel.db import open_pool
from inspiration.kernel.plugins import registry
from inspiration.store import (
    IntegrityError,
    MemoryKeywordIndex,
    MemoryStore,
    MemoryVectorIndex,
    PgSearchIndex,
    PgVectorIndex,
    PostgresStore,
)
from inspiration.store.testing import Sample

BACKENDS = ["memory", pytest.param("postgres", marks=pytest.mark.integration)]

DOCS = {
    "cap": "第三条 住宿标准：一线城市每晚不超过600元，其他城市每晚不超过450元。",
    "trad": "第五條 出差住宿標準按城市等級執行。",  # traditional characters
    "approval": "第四条 超标住宿须经部门负责人审批。",
    "revenue": "Quarterly revenue report for the sales team.",
}

Indexes = tuple[MemoryStore | PostgresStore, VectorIndex, KeywordIndex]


def unit(*xs: float) -> list[float]:
    n = math.sqrt(sum(x * x for x in xs))
    return [x / n for x in xs]


@pytest.fixture(params=BACKENDS)
async def indexes(request: pytest.FixtureRequest) -> AsyncIterator[Indexes]:
    if request.param == "memory":
        mem = MemoryStore()
        yield mem, MemoryVectorIndex(mem), MemoryKeywordIndex(mem)
        return
    pool = await open_pool(request.getfixturevalue("database_url"))
    yield PostgresStore(pool), PgVectorIndex(pool), PgSearchIndex(pool)
    await pool.close()


@pytest.fixture
async def chunks(indexes: Indexes) -> dict[str, Any]:
    """One chunk per DOCS entry. "approval" is confidential; "revenue" is in another space
    and readable only by the sales group."""
    store, _, _ = indexes
    kb = Sample()
    sv, spans = kb.source_version(list(DOCS.values()))
    out = {}
    for (key, _), span in zip(DOCS.items(), spans, strict=True):
        overrides: dict[str, Any] = {}
        if key == "approval":
            overrides["sensitivity"] = SensitivityLabel.confidential
        if key == "revenue":
            overrides |= {"space_id": "spc_01JC00000000000000000SALES", "acl_tokens": ["grp:sales"]}
        out[key] = kb.chunk(sv, [span], **overrides)
    vectors = {
        out["cap"].id: unit(1, 0.1, 0),
        out["trad"].id: unit(0.8, 0.3, 0),
        out["approval"].id: unit(0.9, 0, 0.2),
        out["revenue"].id: unit(0, 0, 1),
    }
    async with store.transaction() as tx:
        await tx.put_source_version(sv, spans)
        await tx.put_chunks(list(out.values()), vectors, model="fake-embedding")
    out["kb"] = kb
    return out


def everyone(kb: Sample, **overrides: Any) -> IndexFilter:
    fields: dict[str, Any] = {
        "space_ids": [kb.space_id, "spc_01JC00000000000000000SALES"],
        "principal_tokens": [f"tenant:{kb.tenant_id}", "grp:sales"],
        "max_sensitivity": SensitivityLabel.secret,
    }
    fields.update(overrides)
    return IndexFilter(**fields)


async def test_bm25_matches_chinese_including_traditional(indexes: Indexes, chunks: dict[str, Any]) -> None:
    _, _, keyword = indexes
    hits = await keyword.search("住宿标准", 10, everyone(chunks["kb"]))
    ids = [h.chunk_id for h in hits]
    assert chunks["cap"].id in ids and chunks["trad"].id in ids  # 標準 folds to 标准
    assert chunks["revenue"].id not in ids
    assert [h.rank for h in hits] == list(range(1, len(hits) + 1))
    assert all(a.score >= b.score for a, b in itertools.pairwise(hits))
    latin = await keyword.search("revenue", 10, everyone(chunks["kb"]))
    assert [h.chunk_id for h in latin] == [chunks["revenue"].id]


async def test_bm25_applies_the_filter_before_top_k(indexes: Indexes, chunks: dict[str, Any]) -> None:
    _, _, keyword = indexes
    kb = chunks["kb"]
    internal_only = await keyword.search("住宿", 10, everyone(kb, max_sensitivity=SensitivityLabel.internal))
    assert chunks["approval"].id not in {h.chunk_id for h in internal_only}
    one_space = await keyword.search("revenue 住宿", 10, everyone(kb, space_ids=[kb.space_id]))
    assert chunks["revenue"].id not in {h.chunk_id for h in one_space}
    no_group = await keyword.search("revenue", 10, everyone(kb, principal_tokens=[f"tenant:{kb.tenant_id}"]))
    assert no_group == []
    assert await keyword.search("住宿", 10, everyone(kb, principal_tokens=[])) == []
    assert await keyword.search("  ", 10, everyone(kb)) == []
    top1 = await keyword.search("住宿", 1, everyone(kb, max_sensitivity=SensitivityLabel.internal))
    assert len(top1) == 1 and top1[0].chunk_id != chunks["approval"].id


async def test_vector_search_ranks_by_cosine_within_the_filter(indexes: Indexes, chunks: dict[str, Any]) -> None:
    _, vector, _ = indexes
    kb = chunks["kb"]
    hits = await vector.search(unit(1, 0.1, 0), 3, everyone(kb))
    assert [h.chunk_id for h in hits] == [chunks["cap"].id, chunks["approval"].id, chunks["trad"].id]
    assert hits[0].score == pytest.approx(1.0, abs=1e-6)
    filtered = await vector.search(unit(1, 0.1, 0), 2, everyone(kb, max_sensitivity=SensitivityLabel.internal))
    assert [h.chunk_id for h in filtered] == [chunks["cap"].id, chunks["trad"].id]
    assert await vector.search(unit(1, 0, 0, 0), 3, everyone(kb)) == []  # other dimensions: no match


async def test_vector_upsert_and_delete(indexes: Indexes, chunks: dict[str, Any]) -> None:
    _, vector, _ = indexes
    kb = chunks["kb"]
    await vector.upsert({chunks["revenue"].id: unit(1, 0.1, 0)}, model="fake-embedding")
    hits = await vector.search(unit(1, 0.1, 0), 2, everyone(kb))
    assert {h.chunk_id for h in hits} == {chunks["cap"].id, chunks["revenue"].id}
    await vector.delete([chunks["cap"].id])
    assert chunks["cap"].id not in {h.chunk_id for h in await vector.search(unit(1, 0.1, 0), 5, everyone(kb))}
    with pytest.raises(IntegrityError):
        await vector.upsert({"chk_01JC00000000000000000NOPE": unit(1, 0, 0)}, model="fake-embedding")


async def test_removing_a_chunk_removes_it_from_both_indexes(indexes: Indexes, chunks: dict[str, Any]) -> None:
    store, vector, keyword = indexes
    kb = chunks["kb"]
    async with store.transaction() as tx:
        await tx.remove_chunks([chunks["cap"].id])
    assert chunks["cap"].id not in {h.chunk_id for h in await keyword.search("住宿标准", 10, everyone(kb))}
    assert chunks["cap"].id not in {h.chunk_id for h in await vector.search(unit(1, 0.1, 0), 10, everyone(kb))}


@pytest.mark.integration
async def test_1024_dimension_vectors_use_the_hnsw_path(database_url: str) -> None:
    pool = await open_pool(database_url)
    store, vector = PostgresStore(pool), PgVectorIndex(pool, model="qwen3-embedding")
    kb = Sample()
    sv, spans = kb.source_version(["a", "b"])
    chunks = [kb.chunk(sv, [s]) for s in spans]
    vectors = {chunks[0].id: unit(*([1.0] + [0.0] * 1023)), chunks[1].id: unit(*([0.0, 1.0] + [0.0] * 1022))}
    async with store.transaction() as tx:
        await tx.put_source_version(sv, spans)
        await tx.put_chunks(chunks, vectors, model="qwen3-embedding")
    hits = await vector.search(vectors[chunks[1].id], 1, everyone(kb))
    assert [h.chunk_id for h in hits] == [chunks[1].id]
    other_model = await PgVectorIndex(pool, model="bge-m3").search(vectors[chunks[1].id], 1, everyone(kb))
    assert other_model == []
    await pool.close()


def test_index_plugins_are_registered() -> None:
    assert {"pgvector", "memory"} <= set(registry("vector_indexes").names())
    assert {"pg_search", "memory"} <= set(registry("keyword_indexes").names())
