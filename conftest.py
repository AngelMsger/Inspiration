"""Shared pytest fixtures.

Integration tests (marked `integration`) need the compose stack from `make up`. They are
skipped when it is not reachable, unless INSPIRATION_REQUIRE_STACK=1 (set in CI), in which
case they fail instead.

Each integration test gets its own database, copied from a migrated template, and its own
Valkey key prefix, so tests never see each other's data.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Iterator

import psycopg
import pytest

ADMIN_URL = os.environ.get("INSPIRATION_TEST_ADMIN_URL", "postgresql://inspiration:inspiration@localhost:5432/postgres")
VALKEY_URL = os.environ.get("INSPIRATION_TEST_VALKEY_URL", "redis://localhost:6379/15")
SPICEDB_ENDPOINT = os.environ.get("INSPIRATION_TEST_SPICEDB_ENDPOINT", "localhost:50051")
SPICEDB_KEY = os.environ.get("INSPIRATION_TEST_SPICEDB_KEY", "inspiration-dev-key")
TEMPLATE_DB = "inspiration_test_template"


def _with_db(url: str, db: str) -> str:
    return url.rsplit("/", 1)[0] + "/" + db


def _stack_reachable() -> bool:
    try:
        with psycopg.connect(ADMIN_URL, connect_timeout=2):
            pass
    except psycopg.OperationalError:
        return False
    return True


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("INSPIRATION_REQUIRE_STACK") == "1" or _stack_reachable():
        return
    skip = pytest.mark.skip(reason="compose stack not running (make up)")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def template_database() -> Iterator[str]:
    """A database with every migration applied, used as the template for test databases."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    from inspiration.kernel.migrate import apply

    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {TEMPLATE_DB} WITH (FORCE)")
        conn.execute(f"CREATE DATABASE {TEMPLATE_DB}")
    url = _with_db(ADMIN_URL, TEMPLATE_DB)
    with psycopg.connect(url, autocommit=True) as conn:
        for ext in ("vector", "pg_search", "pg_trgm"):
            conn.execute(f"CREATE EXTENSION IF NOT EXISTS {ext}")
    # A private loop in another thread: this fixture may be first requested from inside a
    # running event loop (an async fixture calling getfixturevalue).
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(asyncio.run, apply(url)).result()
    yield url
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {TEMPLATE_DB} WITH (FORCE)")


@pytest.fixture
def database_url(template_database: str) -> Iterator[str]:
    name = f"inspiration_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"CREATE DATABASE {name} TEMPLATE {TEMPLATE_DB}")
    yield _with_db(ADMIN_URL, name)
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
def stream_prefix() -> str:
    return f"test-{uuid.uuid4().hex[:10]}"


@pytest.fixture
async def valkey(stream_prefix: str) -> AsyncIterator[object]:
    from redis.asyncio import Redis

    client = Redis.from_url(VALKEY_URL, decode_responses=True)
    yield client
    keys = [k async for k in client.scan_iter(match=f"{stream_prefix}:*")]
    if keys:
        await client.delete(*keys)
    await client.aclose()
