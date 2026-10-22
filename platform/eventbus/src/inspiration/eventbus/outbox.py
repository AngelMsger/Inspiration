"""Writing events to the transactional outbox."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from inspiration.contracts.models import EventEnvelope

INSERT = """
INSERT INTO bus.outbox (event_id, event_type, tenant_id, subject, envelope)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (event_id) DO NOTHING
"""


async def write_outbox(conn: AsyncConnection[Any], events: Sequence[EventEnvelope]) -> None:
    """Insert events using the caller's connection, inside the caller's transaction."""
    if not events:
        return
    async with conn.cursor() as cur:
        await cur.executemany(
            INSERT,
            [
                (e.id, e.type, e.tenant_id, e.subject, Jsonb(e.model_dump(mode="json", exclude_none=True)))
                for e in events
            ],
        )


class OutboxPublisher:
    """EventPublisher for code that is not inside a store transaction."""

    def __init__(self, pool: AsyncConnectionPool[Any]) -> None:
        self.pool = pool

    async def publish(self, *events: EventEnvelope) -> None:
        async with self.pool.connection() as conn, conn.transaction():
            await write_outbox(conn, events)
