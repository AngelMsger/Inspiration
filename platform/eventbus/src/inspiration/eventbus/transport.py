"""The delivery layer under the bus. Valkey Streams in the prototype; NATS JetStream or
Kafka later, behind the same protocol, without changes to module code."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from inspiration.contracts.models import EventEnvelope


@dataclass(frozen=True)
class Delivery:
    """One delivery of one event to one consumer group."""

    event: EventEnvelope | None  # None when the message could not be parsed
    stream: str
    message_id: str
    attempt: int  # 1 on first delivery
    raw: str | None = None  # the unparsed payload, kept for dead-lettering poison messages


class Transport(Protocol):
    async def send(self, events: Sequence[EventEnvelope]) -> None:
        """Append events to their streams. Must be safe to repeat (consumers dedupe on event id)."""
        ...

    async def ensure_group(self, group: str, event_types: Sequence[str]) -> None:
        """Create the consumer group on each event type's stream, starting from the oldest retained event."""
        ...

    async def receive(
        self, group: str, consumer: str, event_types: Sequence[str], *, count: int, block_ms: int
    ) -> list[Delivery]:
        """New events for the group. Returned deliveries stay pending until acked."""
        ...

    async def reclaim(
        self, group: str, consumer: str, event_types: Sequence[str], *, min_idle_ms: int, count: int
    ) -> list[Delivery]:
        """Take over deliveries pending longer than min_idle_ms (failed handlers, dead consumers)."""
        ...

    async def ack(self, group: str, delivery: Delivery) -> None: ...

    async def dead_letter(self, group: str, delivery: Delivery, error: str) -> None:
        """Move a delivery to the group's dead-letter stream and ack it."""
        ...

    async def close(self) -> None: ...
