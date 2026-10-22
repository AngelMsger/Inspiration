"""Outbox, relay and Valkey Streams consumers against the real stack."""

from __future__ import annotations

import asyncio
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from inspiration.contracts import new_event, new_id
from inspiration.contracts.models import ClaimsUpdated, EventEnvelope
from inspiration.eventbus import Consumer, OutboxRelay, ValkeyStreamsTransport, first_delivery, write_outbox

pytestmark = pytest.mark.integration

TENANT = "ten_01JC0000000000000000000001"


def claims_event() -> EventEnvelope:
    return new_event(
        ClaimsUpdated(origin="extracted", added=[new_id("claim")], updated=[], superseded=[]),
        tenant_id=TENANT,
        producer="m5.extractor",
    )


async def pending_rows(url: str) -> int:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        row = await (await conn.execute("SELECT count(*) FROM bus.outbox WHERE relayed_at IS NULL")).fetchone()
        assert row is not None
        return int(row[0])


async def test_outbox_rows_commit_with_the_transaction(database_url: str) -> None:
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        async with conn.transaction():
            await write_outbox(conn, [claims_event()])
        with pytest.raises(RuntimeError):
            async with conn.transaction():
                await write_outbox(conn, [claims_event()])
                raise RuntimeError("rolled back")
    assert await pending_rows(database_url) == 1


async def test_relay_to_consumer_end_to_end(database_url: str, valkey: Any, stream_prefix: str) -> None:
    transport = ValkeyStreamsTransport(valkey, prefix=stream_prefix)
    consumer = Consumer(transport, name="c1", block_ms=50)
    received: list[str] = []

    async def handler(e: EventEnvelope) -> None:
        received.append(e.id)

    consumer.subscribe("claims.updated", "m6.freshness", handler)
    # The group is created before anything is published; it must still start at the oldest event.
    await consumer.run_once("m6.freshness")

    events = [claims_event() for _ in range(3)]
    async with await psycopg.AsyncConnection.connect(database_url) as conn, conn.transaction():
        await write_outbox(conn, events)

    relay = OutboxRelay(database_url, transport, batch_size=2)
    async with await psycopg.AsyncConnection.connect(database_url, row_factory=dict_row) as work:
        assert await relay.drain(work) == 3
        assert await relay.drain(work) == 0
    assert await pending_rows(database_url) == 0

    await consumer.run_once("m6.freshness")
    assert received == [e.id for e in events]
    assert await consumer.run_once("m6.freshness") == 0


async def test_failed_delivery_is_reclaimed_then_dead_lettered(valkey: Any, stream_prefix: str) -> None:
    transport = ValkeyStreamsTransport(valkey, prefix=stream_prefix)
    consumer = Consumer(transport, name="c1", max_deliveries=2, visibility_timeout_ms=0, block_ms=10)
    attempts = 0

    async def always_fails(e: EventEnvelope) -> None:
        nonlocal attempts
        attempts += 1
        raise ValueError("cannot handle")

    consumer.subscribe("claims.updated", "m7.governance", always_fails)
    await consumer.run_once("m7.governance")
    await transport.send([claims_event()])
    await consumer.run_once("m7.governance")  # attempt 1, stays pending
    await consumer.run_once("m7.governance")  # reclaimed: attempt 2, dead-lettered
    assert attempts == 2
    [dead] = await transport.dead_letters("m7.governance")
    assert "cannot handle" in dead["error"] and dead["attempt"] == "2"
    assert await consumer.run_once("m7.governance") == 0


async def test_relay_runs_and_wakes_on_notify(database_url: str, valkey: Any, stream_prefix: str) -> None:
    transport = ValkeyStreamsTransport(valkey, prefix=stream_prefix)
    relay = OutboxRelay(database_url, transport, poll_interval=30)  # only NOTIFY can wake it in time
    task = asyncio.create_task(relay.run())
    try:
        await asyncio.sleep(0.5)
        event = claims_event()
        async with await psycopg.AsyncConnection.connect(database_url) as conn, conn.transaction():
            await write_outbox(conn, [event])
        for _ in range(50):
            if await valkey.xlen(transport.stream("claims.updated")):
                break
            await asyncio.sleep(0.1)
        assert await valkey.xlen(transport.stream("claims.updated")) == 1
    finally:
        await relay.stop()
        await asyncio.wait_for(task, timeout=5)


async def test_inbox_dedupes_redeliveries(database_url: str) -> None:
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        assert await first_delivery(conn, "m6.freshness", "evt_01JC0000000000000000000001")
        assert not await first_delivery(conn, "m6.freshness", "evt_01JC0000000000000000000001")
        assert await first_delivery(conn, "m7.governance", "evt_01JC0000000000000000000001")
