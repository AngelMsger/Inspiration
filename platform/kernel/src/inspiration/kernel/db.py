"""PostgreSQL connection pools."""

from __future__ import annotations

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


async def open_pool(database_url: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    """Open an async pool whose connections return rows as dicts."""

    async def configure(conn: AsyncConnection) -> None:
        conn.row_factory = dict_row  # type: ignore[assignment]

    pool = AsyncConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        open=False,
        configure=configure,
        kwargs={"autocommit": False},
    )
    await pool.open(wait=True)
    return pool
