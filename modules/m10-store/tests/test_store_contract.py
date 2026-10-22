"""KnowledgeStore contract tests. Every test runs against MemoryStore and PostgresStore."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import timedelta

import pytest

from inspiration.contracts import new_event, stable_id
from inspiration.contracts.models import (
    ClaimDerivation,
    ClaimEvidence,
    ClaimOrigin,
    ClaimQuery,
    ClaimsData,
    ClaimStatus,
    ClaimsUpdated,
    ClaimValue,
    ClaimValueKind,
    DataColumn,
    DependencyEdge,
    DerivationMethod,
    EventEnvelope,
    EvidenceRole,
    FieldType,
    InlineData,
    Interval,
    LineageRelation,
    QueryData,
    RefreshMode,
    RefreshPolicy,
)
from inspiration.store import IntegrityError, MemoryStore, PostgresStore
from inspiration.store.testing import Sample

type Store = MemoryStore | PostgresStore
type Published = Callable[[], Awaitable[list[EventEnvelope]]]

POLICY = [
    "第三条 住宿标准：一线城市每晚不超过600元，其他城市每晚不超过450元。",
    "第四条 超标住宿须经部门负责人审批。",
]


async def seed(store: Store, kb: Sample, texts: list[str] = POLICY):  # type: ignore[no-untyped-def]
    sv, spans = kb.source_version(texts)
    async with store.transaction() as tx:
        await tx.put_source_version(sv, spans)
    return sv, spans


# ------------------------------------------------------------------ sources and spans


async def test_source_versions_are_immutable_and_spans_ordered(store: Store, kb: Sample) -> None:
    sv, spans = await seed(store, kb)
    assert await store.get_source_version(sv.id) == sv
    assert [s.id for s in await store.spans_of(sv.id)] == [s.id for s in spans]
    assert await store.get_spans([spans[1].id, "spn_01JC00000000000000MISSING"]) == [spans[1]]

    changed = sv.model_copy(update={"title": "changed"})
    async with store.transaction() as tx:
        await tx.put_source_version(changed, spans)  # same ID: kept as first written
    assert (await store.get_source_version(sv.id)).title == sv.title  # type: ignore[union-attr]


async def test_latest_source_version_follows_fetch_time(store: Store, kb: Sample) -> None:
    v1, _ = await seed(store, kb)
    v2, spans2 = kb.source_version(["第三条 住宿标准：一线城市每晚不超过650元。"])
    async with store.transaction() as tx:
        await tx.put_source_version(v2, spans2)
    latest = await store.latest_source_version(kb.source_id, "doc-1")
    assert latest is not None and latest.id == v2.id and latest.id != v1.id
    assert await store.latest_source_version(kb.source_id, "doc-404") is None


async def test_spans_must_match_their_version(store: Store, kb: Sample) -> None:
    sv, spans = kb.source_version(POLICY)
    other, _ = kb.source_version(["x"])
    with pytest.raises(IntegrityError, match="belongs to"):
        async with store.transaction() as tx:
            await tx.put_source_version(other, spans)
    bad = spans[0].model_copy(update={"text": "tampered"})
    with pytest.raises(IntegrityError, match="text_hash"):
        async with store.transaction() as tx:
            await tx.put_source_version(sv, [bad])


# ------------------------------------------------------------------ chunks


async def test_chunks_round_trip_and_removal(store: Store, kb: Sample) -> None:
    sv, spans = await seed(store, kb)
    chunks = [kb.chunk(sv, [s], ordinal=i) for i, s in enumerate(spans)]
    async with store.transaction() as tx:
        await tx.put_chunks(chunks, {chunks[0].id: [0.1, 0.2, 0.3]}, model="fake-embedding")
    assert [c.id for c in await store.chunks_of(sv.id)] == [c.id for c in chunks]
    assert await store.get_chunks([chunks[1].id]) == [chunks[1]]

    updated = chunks[0].model_copy(update={"contextual_header": "差旅制度中的住宿标准"})
    async with store.transaction() as tx:
        await tx.put_chunks([updated])
        await tx.remove_chunks([chunks[1].id])
    assert await store.chunks_of(sv.id) == [updated]


async def test_chunk_writes_are_checked(store: Store, kb: Sample) -> None:
    sv, spans = await seed(store, kb)
    chunk = kb.chunk(sv, spans[:1])
    with pytest.raises(IntegrityError, match="model"):
        async with store.transaction() as tx:
            await tx.put_chunks([chunk], {chunk.id: [1.0]})
    with pytest.raises(IntegrityError, match="not in this write"):
        async with store.transaction() as tx:
            await tx.put_chunks([chunk], {"chk_01JC0000000000000000OTHER": [1.0]}, model="m")
    orphan_sv, orphan_spans = kb.source_version(["never stored"])
    with pytest.raises(IntegrityError, match="unknown source version"):
        async with store.transaction() as tx:
            await tx.put_chunks([kb.chunk(orphan_sv, orphan_spans)])


# ------------------------------------------------------------------ claims and evidence


async def test_claims_need_evidence_that_quotes_the_span(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    claim, evidence = kb.claim("一线城市住宿上限为每晚600元", spans[0], quote="一线城市每晚不超过600元")
    async with store.transaction() as tx:
        assert await tx.upsert_claims([claim], evidence) == [claim.id]
    assert await store.get_claims([claim.id]) == [claim]
    assert await store.evidence_of([claim.id]) == evidence
    assert await store.claims_citing([spans[0].id]) == [claim.id]
    assert await store.claims_citing([spans[1].id]) == []

    lonely, _ = kb.claim("没有证据的说法")
    with pytest.raises(IntegrityError, match="no supporting evidence"):
        async with store.transaction() as tx:
            await tx.upsert_claims([lonely], [])

    invented, ev = kb.claim("一线城市每晚700元", spans[0], quote="一线城市每晚不超过600元")
    with pytest.raises(IntegrityError, match="quote is not in span"):
        async with store.transaction() as tx:
            await tx.upsert_claims([invented], [ev[0].model_copy(update={"quote": "每晚不超过700元"})])
    with pytest.raises(IntegrityError, match="offsets"):
        async with store.transaction() as tx:
            await tx.upsert_claims([invented], [ev[0].model_copy(update={"quote_start": 0})])
    assert await store.get_claims([lonely.id, invented.id]) == []


async def test_contradicting_evidence_alone_does_not_support(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    claim, evidence = kb.claim("一线城市每晚700元", spans[0], quote="一线城市每晚不超过600元")
    against = evidence[0].model_copy(update={"role": EvidenceRole.contradicts})
    with pytest.raises(IntegrityError, match="no supporting evidence"):
        async with store.transaction() as tx:
            await tx.upsert_claims([claim], [against])


async def test_updating_a_stored_claim_keeps_its_support(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    claim, evidence = kb.claim("一线城市住宿上限为每晚600元", spans[0])
    async with store.transaction() as tx:
        await tx.upsert_claims([claim], evidence)
    verified = claim.model_copy(update={"status": ClaimStatus.verified, "weight": 2.0})
    async with store.transaction() as tx:
        await tx.upsert_claims([verified], [])
    assert (await store.get_claims([claim.id]))[0].status == ClaimStatus.verified


async def test_derived_claims_need_known_inputs(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    a, ea = kb.claim("一线城市每晚不超过600元", spans[0], quote="一线城市每晚不超过600元")
    b, eb = kb.claim("其他城市每晚不超过450元", spans[0], quote="其他城市每晚不超过450元")
    merged, _ = kb.claim("住宿上限按城市分为600元和450元两档", origin=ClaimOrigin.merged)
    derivation = ClaimDerivation(claim_id=merged.id, from_claim_ids=[a.id, b.id], method=DerivationMethod.merge)
    async with store.transaction() as tx:
        await tx.upsert_claims([a, b, merged], ea + eb, [derivation])
    graph = await store.lineage(merged.id)
    assert {(e.from_id, e.to_id, e.relation) for e in graph.edges} >= {
        (merged.id, a.id, LineageRelation.derived_from),
        (merged.id, b.id, LineageRelation.derived_from),
        (a.id, ea[0].span_id, LineageRelation.cites),
    }

    ghost, _ = kb.claim("凭空推断")
    bad = ClaimDerivation(
        claim_id=ghost.id, from_claim_ids=["clm_01JC00000000000000000GHOST"], method=DerivationMethod.infer
    )
    with pytest.raises(IntegrityError, match="unknown claims"):
        async with store.transaction() as tx:
            await tx.upsert_claims([ghost], [], [bad])


async def test_supersede_and_bitemporal_reads(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    jan, feb = kb.now, kb.now + timedelta(days=31)
    old, ev_old = kb.claim(
        "一线城市住宿上限为每晚600元",
        spans[0],
        quote="一线城市每晚不超过600元",
        predicate="hotel_cap_per_night",
        valid_time=Interval(start=jan, end=feb),
        value=ClaimValue(kind=ClaimValueKind.money, number=600, unit="CNY/night", currency="CNY"),
    )
    async with store.transaction() as tx:
        await tx.upsert_claims([old], ev_old)
    believed_before = kb.tick()
    new, ev_new = kb.claim(
        "一线城市住宿上限为每晚650元",
        spans[0],
        quote="第三条 住宿标准",
        predicate="hotel_cap_per_night",
        valid_time=Interval(start=feb),
    )
    async with store.transaction() as tx:
        await tx.upsert_claims([new], ev_new)
        kb.tick()
        await tx.supersede(old.id, by=new.id, reason="policy revised in February")

    current = await store.as_of(ClaimQuery(predicates=["hotel_cap_per_night"]))
    assert [c.id for c in current] == [new.id]
    then = await store.as_of(ClaimQuery(predicates=["hotel_cap_per_night"]), known_at=believed_before)
    assert [c.id for c in then] == [old.id]
    stored_old = (await store.get_claims([old.id]))[0]
    assert stored_old.status == ClaimStatus.superseded and stored_old.superseded_by == new.id

    # valid_at picks what was true in the world at that time, among current beliefs.
    assert await store.as_of(ClaimQuery(), valid_at=jan + timedelta(days=1)) == []
    in_march = await store.as_of(ClaimQuery(), valid_at=feb + timedelta(days=30))
    assert [c.id for c in in_march] == [new.id]

    with pytest.raises(IntegrityError, match="already superseded"):
        async with store.transaction() as tx:
            await tx.supersede(old.id, by=new.id, reason="again")
    with pytest.raises(IntegrityError, match="unknown claim"):
        async with store.transaction() as tx:
            await tx.supersede("clm_01JC000000000000000NOSUCH", by=new.id, reason="x")


async def test_claim_query_filters(store: Store, kb: Sample) -> None:
    sv, spans = await seed(store, kb)
    other_sv, other_spans = await seed(store, kb, ["第一条 本制度适用于全体员工。"])
    a, ea = kb.claim("一线城市每晚不超过600元", spans[0], knowledge_class="pricing")
    b, eb = kb.claim("超标须审批", spans[1], status=ClaimStatus.proposed)
    c, ec = kb.claim("适用全体员工", other_spans[0], space_id="spc_01JC0000000000000000OTHER")
    async with store.transaction() as tx:
        await tx.upsert_claims([a, b, c], ea + eb + ec)

    async def ids(**q: object) -> list[str]:
        return [x.id for x in await store.as_of(ClaimQuery(**q))]  # type: ignore[arg-type]

    assert await ids() == [a.id, b.id, c.id]
    assert await ids(ids=[b.id]) == [b.id]
    assert await ids(space_ids=[kb.space_id]) == [a.id, b.id]
    assert await ids(statuses=[ClaimStatus.proposed]) == [b.id]
    assert await ids(knowledge_classes=["pricing"]) == [a.id]
    assert await ids(source_version_ids=[other_sv.id]) == [c.id]
    assert await ids(source_version_ids=[sv.id], statuses=[ClaimStatus.active]) == [a.id]
    assert await ids(limit=2) == [a.id, b.id]


# ------------------------------------------------------------------ dependencies, pages, lineage


async def test_dependencies_replace_per_artifact(store: Store, kb: Sample) -> None:
    page = "pg_01JC00000000000000000PAGE1"
    sop = "sop_01JC0000000000000000000SOP1"
    c1, c2 = "clm_01JC0000000000000000000CL1", "clm_01JC0000000000000000000CL2"
    h = "sha256:" + "0" * 64
    async with store.transaction() as tx:
        await tx.record_dependencies(
            [
                DependencyEdge(artifact_id=page, input_id=c1, input_hash=h),
                DependencyEdge(artifact_id=sop, input_id=c1, input_hash=h),
            ]
        )
    assert await store.dependents([c1]) == [page, sop]
    async with store.transaction() as tx:
        await tx.record_dependencies([DependencyEdge(artifact_id=page, input_id=c2, input_hash=h)])
    assert await store.dependents([c1]) == [sop]
    assert await store.dependents([c2]) == [page]


async def test_page_snapshots_are_versioned(store: Store, kb: Sample) -> None:
    page_id = stable_id("page", "travel", "hotel")
    async with store.transaction() as tx:
        await tx.put_page_snapshot(kb.page(page_id, 1))
    async with store.transaction() as tx:
        await tx.put_page_snapshot(kb.page(page_id, 2, change_summary="Hotel cap raised to 650"))
    with pytest.raises(IntegrityError, match="next version is 3"):
        async with store.transaction() as tx:
            await tx.put_page_snapshot(kb.page(page_id, 5))
    with pytest.raises(IntegrityError, match="next version is 3"):
        async with store.transaction() as tx:
            await tx.put_page_snapshot(kb.page(page_id, 2))

    latest = await store.get_page(page_id)
    assert latest is not None and latest.version == 2
    first = await store.get_page(page_id, 1)
    assert first is not None and first.spec.version == 1
    assert await store.get_page(page_id, 9) is None
    history = await store.page_history(page_id)
    assert [(h.version, h.change_summary) for h in history] == [(1, None), (2, "Hotel cap raised to 650")]
    assert history[1].inputs_hash == latest.spec.inputs_hash


async def test_lineage_runs_from_a_page_to_the_source(store: Store, kb: Sample) -> None:
    sv, spans = await seed(store, kb)
    claim, evidence = kb.claim("一线城市住宿上限为每晚600元", spans[0])
    page_id = stable_id("page", "travel", "hotel")
    async with store.transaction() as tx:
        await tx.upsert_claims([claim], evidence)
        await tx.put_page_snapshot(kb.page(page_id, 1, [claim.id]))
        await tx.record_dependencies(
            [DependencyEdge(artifact_id=page_id, input_id=claim.id, input_hash=claim.inputs_hash)]
        )

    graph = await store.lineage(page_id)
    edges = {(e.from_id, e.to_id, e.relation) for e in graph.edges}
    assert edges == {
        (page_id, claim.id, LineageRelation.depends_on),
        (claim.id, spans[0].id, LineageRelation.cites),
        (sv.id, spans[0].id, LineageRelation.contains),
    }
    labels = {n.id: n.label for n in graph.nodes}
    assert labels[page_id] == "差旅住宿标准" and labels[sv.id] == sv.title
    assert labels[claim.id] == claim.statement
    assert not graph.truncated

    shallow = await store.lineage(page_id, depth=1)
    assert shallow.truncated and {n.id for n in shallow.nodes} == {page_id, claim.id}


# ------------------------------------------------------------------ transactions and events


async def test_a_failed_transaction_keeps_nothing(store: Store, kb: Sample, published: Published) -> None:
    sv, spans = kb.source_version(POLICY)
    claim, evidence = kb.claim("一线城市住宿上限为每晚600元", spans[0])
    event = new_event(
        ClaimsUpdated(origin=ClaimOrigin.extracted, added=[claim.id], updated=[], superseded=[]),
        tenant_id=kb.tenant_id,
        producer="m5.extractor",
    )
    with pytest.raises(RuntimeError):
        async with store.transaction() as tx:
            await tx.put_source_version(sv, spans)
            await tx.upsert_claims([claim], evidence)
            await tx.publish(event)
            raise RuntimeError("extractor crashed")
    assert await store.get_source_version(sv.id) is None
    assert await store.get_claims([claim.id]) == []
    assert await published() == []

    async with store.transaction() as tx:
        await tx.put_source_version(sv, spans)
        await tx.upsert_claims([claim], evidence)
        await tx.publish(event)
    assert [e.id for e in await published()] == [event.id]


# ------------------------------------------------------------------ DataRef resolution

COLUMNS = [
    DataColumn(field="subject", field_type=FieldType.nominal),
    DataColumn(field="value_number", field_type=FieldType.quantitative, unit="CNY/night"),
    DataColumn(field="valid_from", field_type=FieldType.temporal),
]


async def test_claims_data_keeps_claim_ids_per_row(store: Store, kb: Sample) -> None:
    _, spans = await seed(store, kb)
    tier1, e1 = kb.claim(
        "一线城市每晚不超过600元",
        spans[0],
        quote="一线城市每晚不超过600元",
        subject_text="一线城市",
        predicate="hotel_cap_per_night",
        value=ClaimValue(kind=ClaimValueKind.money, number=600, currency="CNY"),
        valid_time=Interval(start=kb.now),
    )
    other, e2 = kb.claim(
        "其他城市每晚不超过450元",
        spans[0],
        quote="其他城市每晚不超过450元",
        subject_text="其他城市",
        predicate="hotel_cap_per_night",
        value=ClaimValue(kind=ClaimValueKind.money, number=450, currency="CNY"),
    )
    async with store.transaction() as tx:
        await tx.upsert_claims([tier1, other], e1 + e2)

    pinned = await store.resolve_data(ClaimsData(claim_ids=[other.id, tier1.id], columns=COLUMNS))
    assert pinned.rows == [["其他城市", 450, None], ["一线城市", 600, tier1.valid_time.start.isoformat()]]  # type: ignore[union-attr]
    assert pinned.row_claim_ids == [[other.id], [tier1.id]]
    assert pinned.snapshot_hash is not None

    live = await store.resolve_data(
        ClaimsData(
            query=ClaimQuery(predicates=["hotel_cap_per_night"]),
            refresh=RefreshPolicy(mode=RefreshMode.on_view),
            columns=COLUMNS[:2],
        )
    )
    assert live.rows == [["一线城市", 600], ["其他城市", 450]]
    assert live.snapshot_hash != pinned.snapshot_hash


async def test_inline_and_query_data(store: Store) -> None:
    inline = await store.resolve_data(
        InlineData(columns=COLUMNS[:2], rows=[["北京", 600]], row_claim_ids=[["clm_01JC0000000000000000000CL1"]])
    )
    assert inline.rows == [["北京", 600]] and inline.row_claim_ids == [["clm_01JC0000000000000000000CL1"]]

    columns = [
        DataColumn(field="query", field_type=FieldType.nominal),
        DataColumn(field="n", field_type=FieldType.quantitative),
    ]
    table = await store.resolve_data(
        QueryData(
            provider="static",
            query_id="spend.by_city",
            params={"n": 3},
            columns=columns,
            refresh=RefreshPolicy(mode=RefreshMode.scheduled, schedule="0 6 * * *"),
        )
    )
    assert table.rows == [["spend.by_city", 3]] and table.snapshot_hash is not None
    with pytest.raises(LookupError, match="jiandaoyun"):
        await store.resolve_data(
            QueryData(
                provider="jiandaoyun.records",
                query_id="q",
                columns=columns,
                refresh=RefreshPolicy(mode=RefreshMode.on_rebuild),
            )
        )
    with pytest.raises(IntegrityError, match="claim_ids or a query"):
        await store.resolve_data(ClaimsData(columns=COLUMNS))


def test_evidence_model_fields_used_by_rules() -> None:
    # Guards the rule code against contract renames.
    assert {"quote", "quote_start", "quote_end", "span_id", "role"} <= set(ClaimEvidence.model_fields)


async def test_acl_snapshots_are_kept_per_hash(store: Store, kb: Sample) -> None:
    from datetime import UTC, datetime

    from inspiration.contracts import content_hash
    from inspiration.contracts.models import AclEntry, AclFidelity, AclPrincipalKind, AclRole, AclSnapshot

    def snap(role: AclRole, at: datetime) -> AclSnapshot:
        entries = [AclEntry(principal_kind=AclPrincipalKind.anyone_in_tenant, role=role)]
        return AclSnapshot(
            source_id=kb.source_id,
            external_id="doc-1",
            fidelity=AclFidelity.exact,
            entries=entries,
            captured_at=at,
            acl_hash=content_hash(role.value),
        )

    old, new = (
        snap(AclRole.viewer, datetime(2026, 1, 1, tzinfo=UTC)),
        snap(AclRole.editor, datetime(2026, 2, 1, tzinfo=UTC)),
    )
    async with store.transaction() as tx:
        await tx.put_acl_snapshot(old)
        await tx.put_acl_snapshot(new)
        await tx.put_acl_snapshot(old)  # repeated delivery
    assert await store.get_acl_snapshot(kb.source_id, "doc-1", old.acl_hash) == old
    assert await store.get_acl_snapshot(kb.source_id, "doc-1") == new
    assert await store.get_acl_snapshot(kb.source_id, "doc-2") is None
