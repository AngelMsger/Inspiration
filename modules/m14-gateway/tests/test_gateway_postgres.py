from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from psycopg_pool import AsyncConnectionPool

from inspiration.contracts.models import (
    AgentResult,
    AgentRunStatus,
    CompletionRequest,
    GatewayErrorCode,
    Money,
    TokenUsage,
)
from inspiration.gateway import Gateway, GatewayException, PostgresRuns, PostgresUsage
from inspiration.gateway.cache import ValkeyCache
from inspiration.kernel.db import open_pool

pytestmark = pytest.mark.integration


@pytest.fixture
async def pool(database_url: str) -> AsyncIterator[AsyncConnectionPool[Any]]:
    pool = await open_pool(database_url)
    yield pool
    await pool.close()


async def test_usage_is_written_and_budgets_sum_it(
    pool: AsyncConnectionPool[Any],
    make_gateway: Callable[..., Gateway],
    completion_request: Callable[..., CompletionRequest],
) -> None:
    usage = PostgresUsage(pool)
    gw = make_gateway(usage=usage)
    first = await gw.complete(completion_request("word " * 200, budget_key="tenant:capped/m5"))
    with pytest.raises(GatewayException) as exc:
        await gw.complete(completion_request("again", budget_key="tenant:capped/m5"))
    assert exc.value.code == GatewayErrorCode.budget_exceeded

    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT * FROM gateway.usage ORDER BY at")).fetchall()
    assert [r["status"] for r in rows] == ["ok", "budget_exceeded"]
    assert rows[0]["request_id"] == first.request_id and rows[0]["provider"] == "cloud"
    assert float(rows[0]["cost"]) == pytest.approx(first.cost.amount)
    assert await usage.spent("tenant:capped/m5", None) == pytest.approx(first.cost.amount)
    assert await usage.spent("tenant:capped/m5", datetime.now(UTC) + timedelta(minutes=1)) == 0
    assert await usage.spent("tenant:other", None) == 0


async def test_agent_runs_round_trip(pool: AsyncConnectionPool[Any]) -> None:
    runs = PostgresRuns(pool)
    now = datetime.now(UTC)
    result = AgentResult(
        run_id="run_01JC000000000000000000RUN1",
        agent="m9.comment_assistant",
        agent_version="0.1.0",
        status=AgentRunStatus.needs_approval,
        output={"reply": "ok"},
        steps=[],
        proposal_ids=["prp_01JC000000000000000000PRP1"],
        usage=TokenUsage(input_tokens=10, output_tokens=2),
        cost=Money(amount=0.001, currency="CNY"),
        trace_id="trace-1",
        started_at=now,
        finished_at=now,
    )
    await runs.save(result, principal_id="agt_01JC000000000000000000AGT1")
    await runs.save(result.model_copy(update={"status": AgentRunStatus.completed}), principal_id="x")
    loaded = await runs.get(result.run_id)
    assert loaded is not None and loaded.status == AgentRunStatus.completed and loaded.output == {"reply": "ok"}
    assert await runs.get("run_01JC0000000000000000MISSING") is None


async def test_valkey_cache_serves_repeated_completions(
    valkey: Any,
    stream_prefix: str,
    make_gateway: Callable[..., Gateway],
    completion_request: Callable[..., CompletionRequest],
) -> None:
    cache = ValkeyCache(valkey, prefix=stream_prefix)
    gw = make_gateway(cache=cache)
    await gw.complete(completion_request("cache me"))
    again = await make_gateway(cache=cache).complete(completion_request("cache me"))  # another process, same cache
    assert again.cached
    keys = [k async for k in valkey.scan_iter(match=f"{stream_prefix}:gw:cache:*")]
    assert len(keys) == 1 and 0 < await valkey.ttl(keys[0]) <= gw.config.cache.ttl_s
