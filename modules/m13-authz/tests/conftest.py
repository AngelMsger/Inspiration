from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest

from inspiration.authz import Graph, MemoryGraph, SpiceDBGraph, connect, write_schema

BACKENDS = ["memory", pytest.param("spicedb", marks=pytest.mark.integration)]
ENDPOINT = os.environ.get("INSPIRATION_TEST_SPICEDB_ENDPOINT", "localhost:50051")
KEY = os.environ.get("INSPIRATION_TEST_SPICEDB_KEY", "inspiration-dev-key")

_schema_written = False


@pytest.fixture(params=BACKENDS)
async def graph(request: pytest.FixtureRequest) -> AsyncIterator[Graph]:
    """Each test uses fresh IDs, so SpiceDB tests share one instance without clearing it."""
    global _schema_written
    if request.param == "memory":
        yield MemoryGraph()
        return
    client = connect(ENDPOINT, KEY, insecure=True)
    if not _schema_written:
        await write_schema(client)
        _schema_written = True
    yield SpiceDBGraph(client)
