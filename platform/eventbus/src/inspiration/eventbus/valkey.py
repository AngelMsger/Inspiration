"""Valkey Streams transport (also works against Redis 6.2+).

One stream per event type ("<prefix>:ev:<type>"), one consumer group per module, a
dead-letter stream per group ("<prefix>:dlq:<group>"). Streams are trimmed approximately
to maxlen entries.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import ValidationError
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from inspiration.contracts.models import EventEnvelope

from .transport import Delivery


class ValkeyStreamsTransport:
    def __init__(self, client: Redis, *, prefix: str = "insp", maxlen: int = 1_000_000) -> None:
        self.client = client
        self.prefix = prefix
        self.maxlen = maxlen

    @classmethod
    def from_url(cls, url: str, **kwargs: Any) -> ValkeyStreamsTransport:
        return cls(Redis.from_url(url, decode_responses=True), **kwargs)

    def stream(self, event_type: str) -> str:
        return f"{self.prefix}:ev:{event_type}"

    def dlq(self, group: str) -> str:
        return f"{self.prefix}:dlq:{group}"

    async def send(self, events: Sequence[EventEnvelope]) -> None:
        if not events:
            return
        async with self.client.pipeline(transaction=False) as pipe:
            for ev in events:
                pipe.xadd(
                    self.stream(ev.type),
                    {"e": ev.model_dump_json(exclude_none=True)},
                    maxlen=self.maxlen,
                    approximate=True,
                )
            await pipe.execute()

    async def ensure_group(self, group: str, event_types: Sequence[str]) -> None:
        for t in event_types:
            try:
                await self.client.xgroup_create(self.stream(t), group, id="0", mkstream=True)
            except ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise

    def _delivery(self, stream: str, message_id: str, fields: dict[str, str], attempt: int) -> Delivery:
        raw = fields.get("e")
        try:
            event = EventEnvelope.model_validate_json(raw) if raw is not None else None
        except ValidationError:
            event = None
        return Delivery(event=event, stream=stream, message_id=message_id, attempt=attempt, raw=raw)

    async def receive(
        self, group: str, consumer: str, event_types: Sequence[str], *, count: int, block_ms: int
    ) -> list[Delivery]:
        streams = {self.stream(t): ">" for t in event_types}
        # redis-py's reply types are loose; with decode_responses=True everything is str.
        # BLOCK 0 means "wait forever" to Valkey, so a zero block_ms must omit BLOCK entirely.
        block = block_ms if block_ms > 0 else None
        reply: Any = await self.client.xreadgroup(group, consumer, streams, count=count, block=block)  # type: ignore[arg-type]
        out = []
        for stream, messages in reply or []:
            for message_id, fields in messages:
                out.append(self._delivery(stream, message_id, fields, attempt=1))
        return out

    async def reclaim(
        self, group: str, consumer: str, event_types: Sequence[str], *, min_idle_ms: int, count: int
    ) -> list[Delivery]:
        out: list[Delivery] = []
        for t in event_types:
            stream = self.stream(t)
            reply: Any = await self.client.xautoclaim(
                stream, group, consumer, min_idle_time=min_idle_ms, start_id="0-0", count=count
            )
            messages = reply[1]
            for message_id, fields in messages:
                pending: Any = await self.client.xpending_range(stream, group, min=message_id, max=message_id, count=1)
                attempt = int(pending[0]["times_delivered"]) if pending else 1
                out.append(self._delivery(stream, message_id, fields or {}, attempt))
        return out

    async def ack(self, group: str, delivery: Delivery) -> None:
        await self.client.xack(delivery.stream, group, delivery.message_id)

    async def dead_letter(self, group: str, delivery: Delivery, error: str) -> None:
        await self.client.xadd(
            self.dlq(group),
            {
                "e": delivery.raw or "",
                "stream": delivery.stream,
                "message_id": delivery.message_id,
                "attempt": str(delivery.attempt),
                "error": error[:2000],
            },
            maxlen=self.maxlen,
            approximate=True,
        )
        await self.ack(group, delivery)

    async def dead_letters(self, group: str, count: int = 100) -> list[dict[str, str]]:
        """Inspect a group's dead-letter stream (operations and tests)."""
        rows: Any = await self.client.xrange(self.dlq(group), count=count)
        return [dict(fields) | {"id": message_id} for message_id, fields in rows]

    async def close(self) -> None:
        await self.client.aclose()
