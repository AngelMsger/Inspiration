"""Agent run traces (gateway.agent_runs), kept for review, replay and evals."""

from __future__ import annotations

from typing import Any, Protocol

from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from inspiration.contracts.models import AgentResult


class RunStore(Protocol):
    async def save(self, result: AgentResult, *, principal_id: str) -> None: ...

    async def get(self, run_id: str) -> AgentResult | None: ...


class MemoryRuns:
    def __init__(self) -> None:
        self.runs: dict[str, AgentResult] = {}

    async def save(self, result: AgentResult, *, principal_id: str) -> None:
        self.runs[result.run_id] = result

    async def get(self, run_id: str) -> AgentResult | None:
        return self.runs.get(run_id)


class PostgresRuns:
    INSERT = """
    INSERT INTO gateway.agent_runs
        (run_id, agent, version, status, trace_id, principal, started_at, finished_at, result)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
        result = excluded.result
    """

    def __init__(self, pool: AsyncConnectionPool[Any]) -> None:
        self.pool = pool

    async def save(self, result: AgentResult, *, principal_id: str) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                self.INSERT,
                (
                    result.run_id,
                    result.agent,
                    result.agent_version,
                    result.status.value,
                    result.trace_id,
                    principal_id,
                    result.started_at,
                    result.finished_at,
                    Jsonb(result.model_dump(mode="json", exclude_none=True)),
                ),
            )

    async def get(self, run_id: str) -> AgentResult | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT result FROM gateway.agent_runs WHERE run_id = %s", (run_id,))
            row = await cur.fetchone()
        if row is None:
            return None
        doc = row["result"] if isinstance(row, dict) else row[0]
        return AgentResult.model_validate(doc)
