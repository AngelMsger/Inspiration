"""Exactly-once effects for handlers that write to Postgres.

async with pool.connection() as conn, conn.transaction():
    if not await first_delivery(conn, "m6.freshness", event.id):
        return  # already handled
    ...  # the handler's writes, committed together with the inbox row
"""

from __future__ import annotations

from typing import Any

from psycopg import AsyncConnection


async def first_delivery(conn: AsyncConnection[Any], group: str, event_id: str) -> bool:
    cur = await conn.execute(
        "INSERT INTO bus.inbox (consumer_group, event_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (group, event_id),
    )
    return cur.rowcount == 1
