"""In-memory transport and bus, for module tests that should not need Valkey or Postgres.

InMemoryTransport has the same semantics as the Valkey transport (per-type streams,
consumer groups starting at the oldest event, pending deliveries, reclaim, dead letters),
so the real Consumer runs on it unchanged. InMemoryBus wraps both with a deterministic
drain() for tests.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass, field

from inspiration.contracts.interfaces import EventHandler
from inspiration.contracts.models import EventEnvelope

from .consumer import Consumer
from .transport import Delivery


@dataclass
class _Pending:
    index: int
    consumer: str
    delivered_at: float
    attempts: int


@dataclass
class _Group:
    next_index: int = 0
    pending: dict[int, _Pending] = field(default_factory=dict)


class InMemoryTransport:
    def __init__(self) -> None:
        self.streams: dict[str, list[EventEnvelope]] = {}
        self.groups: dict[tuple[str, str], _Group] = {}  # (event_type, group)
        self.dlq: dict[str, list[tuple[EventEnvelope | None, str]]] = {}

    async def send(self, events: Sequence[EventEnvelope]) -> None:
        for ev in events:
            self.streams.setdefault(ev.type, []).append(ev)

    async def ensure_group(self, group: str, event_types: Sequence[str]) -> None:
        for t in event_types:
            self.streams.setdefault(t, [])
            self.groups.setdefault((t, group), _Group())

    async def receive(
        self, group: str, consumer: str, event_types: Sequence[str], *, count: int, block_ms: int
    ) -> list[Delivery]:
        out: list[Delivery] = []
        for t in event_types:
            g = self.groups[(t, group)]
            stream = self.streams[t]
            while g.next_index < len(stream) and len(out) < count:
                i = g.next_index
                g.next_index += 1
                g.pending[i] = _Pending(i, consumer, time.monotonic(), 1)
                out.append(Delivery(stream[i], t, str(i), 1, stream[i].model_dump_json()))
        return out

    async def reclaim(
        self, group: str, consumer: str, event_types: Sequence[str], *, min_idle_ms: int, count: int
    ) -> list[Delivery]:
        now = time.monotonic()
        out: list[Delivery] = []
        for t in event_types:
            g = self.groups[(t, group)]
            for p in sorted(g.pending.values(), key=lambda p: p.index):
                if len(out) >= count:
                    break
                if (now - p.delivered_at) * 1000 >= min_idle_ms:
                    p.consumer, p.delivered_at, p.attempts = consumer, now, p.attempts + 1
                    ev = self.streams[t][p.index]
                    out.append(Delivery(ev, t, str(p.index), p.attempts, ev.model_dump_json()))
        return out

    async def ack(self, group: str, delivery: Delivery) -> None:
        self.groups[(delivery.stream, group)].pending.pop(int(delivery.message_id), None)

    async def dead_letter(self, group: str, delivery: Delivery, error: str) -> None:
        self.dlq.setdefault(group, []).append((delivery.event, error))
        await self.ack(group, delivery)

    def pending_count(self, group: str) -> int:
        return sum(len(g.pending) for (_, name), g in self.groups.items() if name == group)

    async def close(self) -> None:
        return None


class InMemoryBus:
    """Publisher and subscriber in one object, for tests.

        bus = InMemoryBus()
        bus.subscribe("claims.updated", "m6.freshness", handler)
        await bus.publish(event)
        await bus.drain()          # runs handlers until nothing is left

    Failed handlers are retried immediately, up to max_deliveries, then dead-lettered.
    """

    def __init__(self, *, max_deliveries: int = 3) -> None:
        self.transport = InMemoryTransport()
        self.consumer = Consumer(self.transport, name="test", max_deliveries=max_deliveries, visibility_timeout_ms=0)
        self.published: list[EventEnvelope] = []

    def subscribe(self, event_type: str, group: str, handler: EventHandler) -> None:
        self.consumer.subscribe(event_type, group, handler)

    async def publish(self, *events: EventEnvelope) -> None:
        self.published.extend(events)
        await self.transport.send(events)

    async def drain(self, max_rounds: int = 100) -> int:
        """Deliver until every group is idle. Returns the number of handler calls."""
        total = 0
        for _ in range(max_rounds):
            handled = 0
            for group in self.consumer.groups():
                handled += await self.consumer.run_once(group)
            total += handled
            if handled == 0:
                return total
        raise RuntimeError("InMemoryBus.drain: handlers keep producing events; possible loop")

    def dead_letters(self, group: str) -> list[tuple[EventEnvelope | None, str]]:
        return self.transport.dlq.get(group, [])

    def of_type(self, event_type: str) -> list[EventEnvelope]:
        return [e for e in self.published if e.type == event_type]
