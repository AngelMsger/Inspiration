"""Write rules every KnowledgeStore implementation enforces, so the in-memory store used in
module tests rejects exactly what Postgres rejects."""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence

from inspiration.contracts import content_hash
from inspiration.contracts.models import (
    Chunk,
    Claim,
    ClaimDerivation,
    ClaimEvidence,
    EvidenceRole,
    PageSnapshot,
    SourceVersion,
    Span,
)


class IntegrityError(ValueError):
    """A write that breaks a knowledge-store rule. The whole transaction is rolled back."""


def check_source_version(version: SourceVersion, spans: Sequence[Span]) -> None:
    for s in spans:
        if s.source_version_id != version.id:
            raise IntegrityError(f"span {s.id} belongs to {s.source_version_id}, not {version.id}")
        if s.tenant_id != version.tenant_id:
            raise IntegrityError(f"span {s.id} has tenant {s.tenant_id}, the version has {version.tenant_id}")
        if s.text_hash != content_hash(s.text):
            raise IntegrityError(f"span {s.id}: text_hash does not match its text")


def check_chunks(
    chunks: Sequence[Chunk],
    versions: Collection[str],
    embeddings: Mapping[str, Sequence[float]] | None,
    model: str | None,
) -> None:
    ids = {c.id for c in chunks}
    for c in chunks:
        if c.source_version_id not in versions:
            raise IntegrityError(f"chunk {c.id} cites unknown source version {c.source_version_id}")
    if embeddings:
        if model is None:
            raise IntegrityError("embeddings need the embedding model name")
        if unknown := set(embeddings) - ids:
            raise IntegrityError(f"embeddings for chunks not in this write: {sorted(unknown)}")
        sizes = {len(v) for v in embeddings.values()}
        if len(sizes) != 1 or 0 in sizes:
            raise IntegrityError("embeddings in one write must share one non-zero size")


def check_evidence(ev: ClaimEvidence, span: Span | None) -> None:
    if span is None:
        raise IntegrityError(f"evidence for {ev.claim_id} cites unknown span {ev.span_id}")
    if span.source_version_id != ev.source_version_id:
        raise IntegrityError(f"span {span.id} belongs to {span.source_version_id}, not {ev.source_version_id}")
    if ev.quote not in span.text:
        raise IntegrityError(f"evidence for {ev.claim_id}: the quote is not in span {span.id}")
    if (ev.quote_start is not None or ev.quote_end is not None) and span.text[
        ev.quote_start : ev.quote_end
    ] != ev.quote:
        raise IntegrityError(f"evidence for {ev.claim_id}: quote offsets do not match span {span.id}")


def check_claims(
    claims: Sequence[Claim],
    evidence: Sequence[ClaimEvidence],
    derivations: Sequence[ClaimDerivation],
    *,
    existing: Collection[str],
    already_supported: Collection[str],
) -> None:
    """existing: IDs of stored claims among those referenced. already_supported: stored
    claims in this batch that already have supporting evidence or a derivation."""
    batch = {c.id for c in claims}
    if len(batch) != len(claims):
        raise IntegrityError("duplicate claim IDs in one write")
    known = batch | set(existing)
    for e in evidence:
        if e.claim_id not in known:
            raise IntegrityError(f"evidence for unknown claim {e.claim_id}")
    for d in derivations:
        if d.claim_id not in known:
            raise IntegrityError(f"derivation for unknown claim {d.claim_id}")
        if d.claim_id in d.from_claim_ids:
            raise IntegrityError(f"claim {d.claim_id} cannot be derived from itself")
        if missing := [f for f in d.from_claim_ids if f not in known]:
            raise IntegrityError(f"claim {d.claim_id} is derived from unknown claims {missing}")
    supported = (
        {e.claim_id for e in evidence if e.role == EvidenceRole.supports}
        | {d.claim_id for d in derivations}
        | set(already_supported)
    )
    for c in claims:
        if c.id not in supported:
            raise IntegrityError(f"claim {c.id} has no supporting evidence or derivation")
        if c.valid_time.start and c.valid_time.end and c.valid_time.end <= c.valid_time.start:
            raise IntegrityError(f"claim {c.id}: valid_time ends before it starts")


def check_supersede(claim: Claim | None, by: Claim | None, claim_id: str, by_id: str) -> None:
    if claim is None:
        raise IntegrityError(f"unknown claim {claim_id}")
    if by is None:
        raise IntegrityError(f"unknown superseding claim {by_id}")
    if claim_id == by_id:
        raise IntegrityError("a claim cannot supersede itself")
    if claim.superseded_at is not None:
        raise IntegrityError(f"claim {claim_id} is already superseded by {claim.superseded_by}")


def check_page_snapshot(snapshot: PageSnapshot, latest: int | None) -> None:
    expected = (latest or 0) + 1
    if snapshot.version != expected:
        raise IntegrityError(f"page {snapshot.page_id}: next version is {expected}, got {snapshot.version}")
    if snapshot.spec.page_id != snapshot.page_id or snapshot.spec.version != snapshot.version:
        raise IntegrityError("the snapshot's spec must carry the same page_id and version")
