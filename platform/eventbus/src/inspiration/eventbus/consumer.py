"""Consumer groups with retries and dead letters, on any Transport.

Each module subscribes under its own group name ("m6.freshness"). Several processes may
run the same group; each event is handled by one of them. Delivery is at least once, so
handlers must be idempotent (see inbox.first_delivery for handlers that write to Postgres).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
from collections import defaultdict

from inspiration.contracts.events import VERSIONS, EventType
from inspiration.contracts.interfaces import EventHandler

from .transport import Delivery, Transport

log = logging.getLogger(__name__)


class Consumer:
    def __init__(
        self,
        transport: Transport,
        *,
        name: str | None = None,
        max_deliveries: int = 5,
        visibility_timeout_ms: int = 60_000,
        block_ms: int = 2_000,
        batch_size: int = 32,
    ) -> None:
        self.transport = transport
        self.name = name or f"{socket.gethostname()}-{os.getpid()}"
        self.max_deliveries = max_deliveries
        self.visibility_timeout_ms = visibility_timeout_ms
        self.block_ms = block_ms
        self.batch_size = batch_size
        self._handlers: dict[str, dict[str, EventHandler]] = defaultdict(dict)  # group -> type -> handler
        self._ready: set[str] = set()
        self._stopping = asyncio.Event()

    def subscribe(self, event_type: str, group: str, handler: EventHandler) -> None:
        EventType(event_type)  # unknown types are a programming error
        if event_type in self._handlers[group]:
            raise ValueError(f"{group} already handles {event_type}")
        self._handlers[group][event_type] = handler
        self._ready.discard(group)

    def groups(self) -> list[str]:
        return sorted(self._handlers)

    async def _ensure(self, group: str) -> list[str]:
        types = sorted(self._handlers[group])
        if group not in self._ready:
            await self.transport.ensure_group(group, types)
            self._ready.add(group)
        return types

    async def _handle(self, group: str, d: Delivery) -> None:
        if d.event is None:
            await self.transport.dead_letter(group, d, "unparseable envelope")
            return
        known = VERSIONS.get(EventType(d.event.type))
        if known is None or d.event.version > known:
            await self.transport.dead_letter(group, d, f"unsupported version {d.event.version} of {d.event.type}")
            return
        handler = self._handlers[group][d.event.type]
        try:
            await handler(d.event)
        except Exception as e:  # handler failures must not stop the loop
            if d.attempt >= self.max_deliveries:
                log.error("dead-lettering %s %s after %d attempts: %r", group, d.event.id, d.attempt, e)
                await self.transport.dead_letter(group, d, repr(e))
            else:
                log.warning("handler failed (%s %s attempt %d): %r", group, d.event.id, d.attempt, e)
            return
        await self.transport.ack(group, d)

    async def run_once(self, group: str, *, block_ms: int = 0) -> int:
        """Handle what is available now (reclaimed first, then new). Returns deliveries handled."""
        types = await self._ensure(group)
        deliveries = await self.transport.reclaim(
            group, self.name, types, min_idle_ms=self.visibility_timeout_ms, count=self.batch_size
        )
        deliveries += await self.transport.receive(group, self.name, types, count=self.batch_size, block_ms=block_ms)
        for d in deliveries:
            await self._handle(group, d)
        return len(deliveries)

    async def _loop(self, group: str) -> None:
        while not self._stopping.is_set():
            try:
                await self.run_once(group, block_ms=self.block_ms)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("consumer loop for %s failed; retrying", group)
                await asyncio.sleep(1)

    async def run(self) -> None:
        """Run every group until stop() is called."""
        self._stopping.clear()
        async with asyncio.TaskGroup() as tg:
            for group in self.groups():
                tg.create_task(self._loop(group))

    async def stop(self) -> None:
        self._stopping.set()
