from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from typing import Any, ClassVar

import pytest

from inspiration.contracts.models import DataColumn, DataTable, EventEnvelope
from inspiration.kernel.db import open_pool
from inspiration.store import MemoryStore, PostgresStore
from inspiration.store.testing import T0, Sample

BACKENDS = ["memory", pytest.param("postgres", marks=pytest.mark.integration)]


class StaticProvider:
    """A data provider that echoes its parameters, for QueryData tests."""

    name: ClassVar[str] = "static"

    async def run(self, query_id: str, params: Mapping[str, Any], columns: Sequence[DataColumn]) -> DataTable:
        rows = [[query_id, params.get("n", 0)]]
        return DataTable(columns=list(columns), rows=rows, resolved_at=T0)


@pytest.fixture
def kb() -> Sample:
    return Sample()


@pytest.fixture(params=BACKENDS)
async def store(request: pytest.FixtureRequest, kb: Sample) -> AsyncIterator[MemoryStore | PostgresStore]:
    providers = {"static": StaticProvider()}
    if request.param == "memory":
        yield MemoryStore(data_providers=providers, clock=lambda: kb.now)
        return
    pool = await open_pool(request.getfixturevalue("database_url"))
    yield PostgresStore(pool, data_providers=providers, clock=lambda: kb.now)
    await pool.close()


@pytest.fixture
def published(store: MemoryStore | PostgresStore) -> Callable[[], Awaitable[list[EventEnvelope]]]:
    """Events committed through store transactions: MemoryStore.published or bus.outbox."""

    async def read() -> list[EventEnvelope]:
        if isinstance(store, MemoryStore):
            return list(store.published)
        async with store.pool.connection() as conn:
            cur = await conn.execute("SELECT envelope FROM bus.outbox ORDER BY seq")
            return [EventEnvelope.model_validate(r["envelope"]) for r in await cur.fetchall()]

    return read
