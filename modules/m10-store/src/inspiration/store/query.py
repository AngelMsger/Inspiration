"""ClaimQuery semantics, written once: as a Python predicate for the in-memory store and as
SQL for Postgres. Both must agree; the contract tests run against both."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from inspiration.contracts.models import Claim, ClaimQuery


def matches(claim: Claim, q: ClaimQuery, *, valid_at: datetime | None, known_at: datetime) -> bool:
    """known_at: the system believed it then. valid_at: it was true in the world then."""
    if claim.recorded_at > known_at or (claim.superseded_at is not None and claim.superseded_at <= known_at):
        return False
    if valid_at is not None:
        start, end = claim.valid_time.start, claim.valid_time.end
        if (start is not None and start > valid_at) or (end is not None and end <= valid_at):
            return False
    checks: list[tuple[list[Any] | None, Any]] = [
        (q.ids, claim.id),
        (q.space_ids, claim.space_id),
        (q.subject_entity_ids, claim.subject_entity_id),
        (q.predicates, claim.predicate),
        (q.statuses, claim.status),
        (q.knowledge_classes, claim.knowledge_class),
    ]
    return all(not wanted or value in wanted for wanted, value in checks)


def to_sql(q: ClaimQuery, *, valid_at: datetime | None, known_at: datetime) -> tuple[str, list[Any]]:
    """WHERE clause over kb.claims (alias c) and its parameters."""
    where = ["c.recorded_at <= %s", "(c.superseded_at IS NULL OR c.superseded_at > %s)"]
    params: list[Any] = [known_at, known_at]
    if valid_at is not None:
        where.append("(c.valid_from IS NULL OR c.valid_from <= %s) AND (c.valid_to IS NULL OR c.valid_to > %s)")
        params += [valid_at, valid_at]
    for column, values in (
        ("c.id", q.ids),
        ("c.space_id", q.space_ids),
        ("c.subject_entity_id", q.subject_entity_ids),
        ("c.predicate", q.predicates),
        ("c.status", [s.value for s in q.statuses] if q.statuses else None),
        ("c.knowledge_class", q.knowledge_classes),
    ):
        if values:
            where.append(f"{column} = ANY(%s)")
            params.append(list(values))
    if q.source_version_ids:
        where.append(
            "EXISTS (SELECT 1 FROM kb.claim_evidence e WHERE e.claim_id = c.id AND e.source_version_id = ANY(%s))"
        )
        params.append(list(q.source_version_ids))
    return " AND ".join(where), params
