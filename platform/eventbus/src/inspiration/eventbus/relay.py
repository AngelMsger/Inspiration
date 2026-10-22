"""The outbox relay: forwards committed outbox rows to the transport, in order.

Only one relay is active per database (it holds an advisory lock); extra replicas wait as
hot standbys. It wakes on NOTIFY from the outbox trigger and also polls, so a lost
notification only delays delivery by poll_interval.

Usage: inspiration-relay [--transport valkey]
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import sys
from datetime import timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row

from inspiration.contracts.models import EventEnvelope
from inspiration.kernel.settings import get_settings

from .transport import Transport

log = logging.getLogger(__name__)

RELAY_LOCK = 0x1A5_0002

SELECT_PENDING = """
SELECT seq, envelope FROM bus.outbox
WHERE relayed_at IS NULL
ORDER BY seq
LIMIT %s
FOR UPDATE SKIP LOCKED
"""


class OutboxRelay:
    def __init__(
        self,
        database_url: str,
        transport: Transport,
        *,
        batch_size: int = 500,
        poll_interval: float = 1.0,
        retention: timedelta = timedelta(days=7),
    ) -> None:
        self.database_url = database_url
        self.transport = transport
        self.batch_size = batch_size
        self.poll_interval = poll_interval
        self.retention = retention
        self._stopping = asyncio.Event()

    async def relay_once(self, conn: psycopg.AsyncConnection[Any]) -> int:
        """Forward one batch. Returns how many events were sent."""
        async with conn.transaction():
            rows = await (await conn.execute(SELECT_PENDING, (self.batch_size,))).fetchall()
            if not rows:
                return 0
            events = [EventEnvelope.model_validate(r["envelope"]) for r in rows]
            await self.transport.send(events)
            await conn.execute(
                "UPDATE bus.outbox SET relayed_at = now() WHERE seq = ANY(%s)", ([r["seq"] for r in rows],)
            )
        return len(rows)

    async def drain(self, conn: psycopg.AsyncConnection[Any]) -> int:
        total = 0
        while (n := await self.relay_once(conn)) > 0:
            total += n
            if n < self.batch_size:
                break
        return total

    async def prune(self, conn: psycopg.AsyncConnection[Any]) -> int:
        async with conn.transaction():
            cur = await conn.execute(
                "DELETE FROM bus.outbox WHERE relayed_at < now() - %s::interval", (self.retention,)
            )
        return cur.rowcount

    async def run(self) -> None:
        self._stopping.clear()
        async with (
            await psycopg.AsyncConnection.connect(self.database_url, autocommit=True) as listen,
            await psycopg.AsyncConnection.connect(self.database_url, row_factory=dict_row) as work,
        ):
            while not self._stopping.is_set():
                row = await (await listen.execute("SELECT pg_try_advisory_lock(%s)", (RELAY_LOCK,))).fetchone()
                if row and row[0]:
                    break
                log.info("another relay is active; standing by")
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stopping.wait(), timeout=5)
            await listen.execute("LISTEN inspiration_outbox")
            log.info("relay active")
            last_prune = 0.0
            loop = asyncio.get_running_loop()
            while not self._stopping.is_set():
                sent = await self.drain(work)
                if sent:
                    log.debug("relayed %d events", sent)
                if loop.time() - last_prune > 3600:
                    await self.prune(work)
                    last_prune = loop.time()
                await self._wait(listen)

    async def _wait(self, listen: psycopg.AsyncConnection[Any]) -> None:
        """Until a NOTIFY arrives, poll_interval passes, or stop() is called."""

        async def notified() -> None:
            async for _ in listen.notifies(timeout=self.poll_interval, stop_after=1):
                pass

        waiters = [asyncio.ensure_future(notified()), asyncio.ensure_future(self._stopping.wait())]
        _, pending = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t

    async def stop(self) -> None:
        self._stopping.set()


def main() -> int:
    from inspiration.kernel.plugins import registry

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--transport", default="valkey")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    transport_cls = registry("event_transports").get(args.transport)
    transport = (
        transport_cls.from_url(settings.valkey_url, prefix=settings.stream_prefix)
        if hasattr(transport_cls, "from_url")
        else transport_cls()
    )
    relay = OutboxRelay(settings.database_url, transport)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(relay.run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
