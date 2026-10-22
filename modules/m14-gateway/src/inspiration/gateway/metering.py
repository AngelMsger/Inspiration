"""Usage records and budget accounting. Budgets are sums of metered cost per period."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from psycopg_pool import AsyncConnectionPool

from inspiration.contracts.models import BudgetPeriod, UsageRecord


class UsageSink(Protocol):
    async def record(self, rec: UsageRecord) -> None: ...

    async def spent(self, budget_key: str, since: datetime | None) -> float: ...


def period_start(period: BudgetPeriod, now: datetime, tz: str) -> datetime | None:
    local = now.astimezone(ZoneInfo(tz))
    if period == BudgetPeriod.day:
        start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == BudgetPeriod.month:
        start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        return None
    return start.astimezone(UTC)


class MemoryUsage:
    def __init__(self) -> None:
        self.records: list[UsageRecord] = []

    async def record(self, rec: UsageRecord) -> None:
        self.records.append(rec)

    async def spent(self, budget_key: str, since: datetime | None) -> float:
        return sum(
            r.cost.amount for r in self.records if r.budget_key == budget_key and (since is None or r.at >= since)
        )


SPENT = """
SELECT coalesce(sum(cost), 0) AS spent FROM gateway.usage
WHERE budget_key = %s AND (%s::timestamptz IS NULL OR at >= %s)
"""


class PostgresUsage:
    """Writes gateway.usage. Budget sums use the (budget_key, at) index."""

    INSERT = """
    INSERT INTO gateway.usage (request_id, at, tenant_id, operation, task, prompt_version, budget_key, sensitivity,
        provider, model, status, input_tokens, output_tokens, cached_tokens, cost, currency, latency_ms, error)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (request_id) DO NOTHING
    """

    def __init__(self, pool: AsyncConnectionPool[Any]) -> None:
        self.pool = pool

    async def record(self, rec: UsageRecord) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                self.INSERT,
                (
                    rec.request_id,
                    rec.at,
                    rec.tenant_id,
                    rec.operation.value,
                    rec.task,
                    rec.prompt_version,
                    rec.budget_key,
                    rec.sensitivity.value,
                    rec.provider,
                    rec.model,
                    rec.status.value,
                    rec.usage.input_tokens,
                    rec.usage.output_tokens,
                    rec.usage.cached_input_tokens or 0,
                    rec.cost.amount,
                    rec.cost.currency,
                    rec.latency_ms,
                    rec.error,
                ),
            )

    async def spent(self, budget_key: str, since: datetime | None) -> float:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                SPENT,
                (budget_key, since, since),
            )
            row = await cur.fetchone()
        assert row is not None
        value = row["spent"] if isinstance(row, dict) else row[0]
        return float(value)
