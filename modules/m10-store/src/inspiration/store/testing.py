"""Builders for knowledge-store test data, for M10's tests and for every module that tests
against MemoryStore. Each builder fills the required fields with plausible values; pass
keyword arguments to override any of them.

    kb = Sample()
    sv, spans = kb.source_version(["差旅住宿标准：一线城市每晚不超过600元。"])
    claim, ev = kb.claim("一线城市住宿上限为每晚600元", spans[0], quote="每晚不超过600元")
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from inspiration.contracts import content_hash, new_id
from inspiration.contracts.models import (
    ApprovalState,
    Chunk,
    Claim,
    ClaimEvidence,
    ClaimOrigin,
    ClaimStatus,
    ClaimType,
    EvidenceRole,
    Interval,
    PageKind,
    PageSnapshot,
    PageSpec,
    ParagraphBlock,
    ProducerInfo,
    SensitivityLabel,
    Sentence,
    SnapshotCause,
    SnapshotCauseKind,
    SourceVersion,
    Span,
    SpanKind,
    SpanLocator,
    Version,
)

T0 = datetime(2026, 1, 1, tzinfo=UTC)


class Sample:
    def __init__(
        self,
        *,
        tenant_id: str = "ten_01JC0000000000000000TENANT",
        space_id: str = "spc_01JC00000000000000000SPACE",
        source_id: str = "src_01JC0000000000000000SOURCE",
        now: datetime = T0,
    ) -> None:
        self.tenant_id = tenant_id
        self.space_id = space_id
        self.source_id = source_id
        self.now = now

    def tick(self, delta: timedelta = timedelta(minutes=1)) -> datetime:
        self.now += delta
        return self.now

    def source_version(
        self,
        texts: Sequence[str],
        *,
        external_id: str = "doc-1",
        title: str = "差旅管理制度",
        **overrides: Any,
    ) -> tuple[SourceVersion, list[Span]]:
        fields: dict[str, Any] = {
            "id": new_id("source_version"),
            "tenant_id": self.tenant_id,
            "source_id": self.source_id,
            "space_id": self.space_id,
            "external_id": external_id,
            "version": Version(content_hash=content_hash("\n".join(texts))),
            "title": title,
            "mime_type": "text/markdown",
            "approval_state": ApprovalState.approved,
            "authority": 0.9,
            "sensitivity": SensitivityLabel.internal,
            "fetched_at": self.tick(),
        }
        fields.update(overrides)
        version = SourceVersion(**fields)
        spans = [self.span(version, text, ordinal=i) for i, text in enumerate(texts)]
        return version, spans

    def span(self, version: SourceVersion, text: str, *, ordinal: int = 0) -> Span:
        return Span(
            id=new_id("span"),
            tenant_id=version.tenant_id,
            source_version_id=version.id,
            locator=SpanLocator(block_anchor=f"b{ordinal}", kind=SpanKind.block),
            text=text,
            text_hash=content_hash(text),
            ordinal=ordinal,
        )

    def chunk(self, version: SourceVersion, spans: Sequence[Span], **overrides: Any) -> Chunk:
        text = "\n".join(s.text for s in spans)
        fields: dict[str, Any] = {
            "id": new_id("chunk"),
            "tenant_id": version.tenant_id,
            "source_version_id": version.id,
            "space_id": version.space_id,
            "ordinal": spans[0].ordinal if spans else 0,
            "span_ids": [s.id for s in spans],
            "heading_path": [version.title],
            "text": text,
            "token_count": len(text),
            "content_hash": content_hash(text),
            "sensitivity": version.sensitivity,
            "acl_tokens": [f"tenant:{version.tenant_id}"],
        }
        fields.update(overrides)
        return Chunk(**fields)

    def claim(
        self,
        statement: str,
        span: Span | None = None,
        *,
        quote: str | None = None,
        **overrides: Any,
    ) -> tuple[Claim, list[ClaimEvidence]]:
        """A claim and, when span is given, evidence quoting `quote` (default: the whole span)."""
        fields: dict[str, Any] = {
            "id": new_id("claim"),
            "tenant_id": self.tenant_id,
            "space_id": self.space_id,
            "statement": statement,
            "claim_type": ClaimType.rule,
            "knowledge_class": "policy",
            "valid_time": Interval(),
            "recorded_at": self.tick(),
            "confidence": 0.9,
            "authority": 0.9,
            "weight": 1.0,
            "status": ClaimStatus.active,
            "origin": ClaimOrigin.extracted,
            "sensitivity": SensitivityLabel.internal,
            "inputs_hash": content_hash(statement),
        }
        fields.update(overrides)
        claim = Claim(**fields)
        if span is None:
            return claim, []
        q = span.text if quote is None else quote
        start = span.text.find(q)
        evidence = ClaimEvidence(
            claim_id=claim.id,
            span_id=span.id,
            source_version_id=span.source_version_id,
            role=EvidenceRole.supports,
            quote=q,
            quote_start=start if start >= 0 else None,
            quote_end=start + len(q) if start >= 0 else None,
        )
        return claim, [evidence]

    def page(self, page_id: str, version: int, claim_ids: Sequence[str] = (), **overrides: Any) -> PageSnapshot:
        spec = PageSpec(
            page_id=page_id,
            tenant_id=self.tenant_id,
            space_id=self.space_id,
            version=version,
            inputs_hash=content_hash(f"{page_id}@{version}"),
            title="差旅住宿标准",
            kind=PageKind.policy,
            locale="zh-CN",
            sensitivity=SensitivityLabel.internal,
            blocks=[
                ParagraphBlock(
                    key="b_intro",
                    sentences=[Sentence(text="一线城市每晚不超过600元。", claim_ids=list(claim_ids))],
                )
            ],
            renderer=ProducerInfo(module="m8.pages", name="page_compiler", version="0.1.0"),
            rendered_at=self.tick(),
        )
        fields: dict[str, Any] = {
            "page_id": page_id,
            "version": version,
            "spec": spec,
            "cause": SnapshotCause(kind=SnapshotCauseKind.initial if version == 1 else SnapshotCauseKind.source_change),
            "created_at": self.now,
        }
        fields.update(overrides)
        return PageSnapshot(**fields)
