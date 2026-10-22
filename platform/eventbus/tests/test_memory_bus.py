from __future__ import annotations

import pytest

from inspiration.contracts import new_event, new_id, payload_of
from inspiration.contracts.models import ClaimsUpdated, EventEnvelope
from inspiration.eventbus import InMemoryBus

TENANT = "ten_01JC0000000000000000000001"


def claims_event() -> EventEnvelope:
    return new_event(
        ClaimsUpdated(origin="extracted", added=[new_id("claim")], updated=[], superseded=[]),
        tenant_id=TENANT,
        producer="m5.extractor",
    )


async def test_delivers_to_each_group_once() -> None:
    bus = InMemoryBus()
    seen: dict[str, list[str]] = {"m6": [], "m7": []}

    async def m6(e: EventEnvelope) -> None:
        seen["m6"].append(e.id)

    async def m7(e: EventEnvelope) -> None:
        seen["m7"].append(payload_of(e, ClaimsUpdated).added[0])

    bus.subscribe("claims.updated", "m6.freshness", m6)
    bus.subscribe("claims.updated", "m7.governance", m7)
    e1, e2 = claims_event(), claims_event()
    await bus.publish(e1, e2)
    assert await bus.drain() == 4
    assert seen["m6"] == [e1.id, e2.id]
    assert len(seen["m7"]) == 2
    assert await bus.drain() == 0


async def test_failing_handler_is_retried_then_dead_lettered() -> None:
    bus = InMemoryBus(max_deliveries=3)
    calls = 0

    async def flaky(e: EventEnvelope) -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    bus.subscribe("claims.updated", "m6.freshness", flaky)
    await bus.publish(claims_event())
    await bus.drain()
    assert calls == 3
    [(event, error)] = bus.dead_letters("m6.freshness")
    assert event is not None and "boom" in error
    assert bus.transport.pending_count("m6.freshness") == 0


async def test_recovers_when_handler_succeeds_on_retry() -> None:
    bus = InMemoryBus(max_deliveries=3)
    attempts = 0

    async def second_time_lucky(e: EventEnvelope) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient")

    bus.subscribe("claims.updated", "m6.freshness", second_time_lucky)
    await bus.publish(claims_event())
    await bus.drain()
    assert attempts == 2
    assert bus.dead_letters("m6.freshness") == []


async def test_newer_payload_version_is_dead_lettered() -> None:
    bus = InMemoryBus()
    handled = []

    async def handler(e: EventEnvelope) -> None:
        handled.append(e)

    bus.subscribe("claims.updated", "m6.freshness", handler)
    future = claims_event().model_copy(update={"version": 99})
    await bus.publish(future)
    await bus.drain()
    assert handled == []
    assert "unsupported version" in bus.dead_letters("m6.freshness")[0][1]


def test_unknown_event_type_is_rejected() -> None:
    bus = InMemoryBus()

    async def handler(e: EventEnvelope) -> None:
        return None

    with pytest.raises(ValueError):
        bus.subscribe("claims.exploded", "m6.freshness", handler)
