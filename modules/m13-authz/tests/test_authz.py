"""M13 contract tests, run against the in-memory evaluator and a real SpiceDB."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

import pytest

from inspiration.authz import (
    AuthzService,
    Graph,
    MemoryGraph,
    Obj,
    Rel,
    Subject,
    acl_tokens,
    document_object_id,
    document_ref,
)
from inspiration.contracts import content_hash, new_id
from inspiration.contracts.models import (
    AclEntry,
    AclFidelity,
    AclPrincipalKind,
    AclRole,
    AclSnapshot,
    ClaimDerivation,
    DerivationMethod,
    Permission,
    Principal,
    PrincipalKind,
    ResourceRef,
    ResourceType,
    SensitivityLabel,
)
from inspiration.store import MemoryStore
from inspiration.store.testing import Sample


def acl(source_id: str, external_id: str, *entries: AclEntry, parent: str | None = None) -> AclSnapshot:
    return AclSnapshot(
        source_id=source_id,
        external_id=external_id,
        fidelity=next(iter(AclFidelity)),
        entries=list(entries),
        inherits_from_external_id=parent,
        captured_at=datetime.now(UTC),
        acl_hash=content_hash(repr(entries)),
    )


def entry(kind: AclPrincipalKind, principal_id: str | None = None, role: AclRole = AclRole.viewer) -> AclEntry:
    return AclEntry(principal_kind=kind, principal_id=principal_id, external_id="ext", role=role)


@dataclass
class World:
    authz: AuthzService
    store: MemoryStore
    kb: Sample
    tenant: str
    space: str
    finance_space: str
    source: str
    ids: dict[str, str]

    def who(self, name: str, **fields: object) -> Principal:
        pid = self.ids[name]
        kind = {"usr": PrincipalKind.user, "svc": PrincipalKind.service, "agt": PrincipalKind.agent}[pid[:3]]
        return Principal(id=pid, kind=kind, tenant_id=self.tenant, **fields)  # type: ignore[arg-type]

    def agent(self, for_: str, **fields: object) -> Principal:
        return Principal(
            id=new_id("agent"),
            kind=PrincipalKind.agent,
            tenant_id=self.tenant,
            on_behalf_of=self.ids[for_],
            **fields,  # type: ignore[arg-type]
        )

    async def can(self, name: str | Principal, perm: Permission, res: ResourceRef) -> bool:
        who = self.who(name) if isinstance(name, str) else name
        return (await self.authz.check(who, perm, res)).allow


@pytest.fixture
async def world(graph: Graph) -> World:
    """alice: finance (nested in managers). bob: sales (a sub-department of the company).
    carol: confidential clearance. dave: not in the tenant. svc: pipeline service."""
    names = {
        "alice": "user",
        "bob": "user",
        "carol": "user",
        "dave": "user",
        "svc": "service",
        "finance": "group",
        "managers": "group",
        "company": "department",
        "sales": "department",
    }
    ids = {n: new_id(kind) for n, kind in names.items()}
    tenant, space, finance_space, source = new_id("tenant"), new_id("space"), new_id("space"), new_id("source")
    kb = Sample(tenant_id=tenant, space_id=space, source_id=source)
    store = MemoryStore()
    authz = AuthzService(graph, store)

    for user in ("alice", "bob", "carol"):
        await authz.add_tenant_member(tenant, ids[user])
    await authz.add_service(tenant, ids["svc"])
    await authz.grant_clearance(tenant, ids["carol"], SensitivityLabel.confidential)
    await authz.add_member(ids["finance"], ids["alice"])
    await authz.add_member(ids["managers"], ids["finance"])
    await authz.add_member(ids["sales"], ids["bob"])
    await authz.add_member(ids["company"], ids["sales"])

    await authz.create_space(space, tenant_id=tenant, owner_id=ids["alice"])
    await authz.grant_space(space, "viewer", tenant)
    await authz.grant_space(space, "editor", ids["bob"])
    await authz.create_space(finance_space, tenant_id=tenant, owner_id=ids["alice"])
    await authz.grant_space(finance_space, "viewer", ids["finance"])
    await authz.register_source(source, space)

    await authz.mirror(
        acl(
            source,
            "doc-managers",
            entry(AclPrincipalKind.group, ids["managers"]),
            entry(AclPrincipalKind.user, ids["bob"]),
        ),
        space_id=space,
    )
    await authz.mirror(acl(source, "doc-all", entry(AclPrincipalKind.anyone_in_tenant)), space_id=space)
    await authz.mirror(
        acl(
            source,
            "doc-company",
            entry(AclPrincipalKind.department, ids["company"], AclRole.commenter),
            entry(AclPrincipalKind.user, None),  # unmapped: ignored
            entry(AclPrincipalKind.external),
        ),
        space_id=space,
    )
    await authz.mirror(acl(source, "doc-link", entry(AclPrincipalKind.anyone_with_link)), space_id=space)
    await authz.mirror(acl(source, "doc-public", entry(AclPrincipalKind.public)), space_id=space)
    return World(authz, store, kb, tenant, space, finance_space, source, ids)


def doc(w: World, external_id: str) -> ResourceRef:
    return document_ref(w.source, external_id)


# ------------------------------------------------------------------ documents


async def test_document_acls_follow_the_source(world: World) -> None:
    w = world
    assert await w.can("alice", Permission.read, doc(w, "doc-managers"))  # finance is nested in managers
    assert await w.can("bob", Permission.read, doc(w, "doc-managers"))
    assert not await w.can("carol", Permission.read, doc(w, "doc-managers"))
    assert await w.can("carol", Permission.read, doc(w, "doc-all"))
    assert not await w.can("dave", Permission.read, doc(w, "doc-all"))
    assert await w.can("bob", Permission.read, doc(w, "doc-company"))  # sales is part of the company
    assert not await w.can("alice", Permission.read, doc(w, "doc-company"))
    assert await w.can("carol", Permission.read, doc(w, "doc-link"))
    assert await w.can("dave", Permission.read, doc(w, "doc-public"))
    assert await w.can("svc", Permission.read, doc(w, "doc-company"))  # services read everything in the tenant
    edit = await w.authz.check(w.who("alice"), Permission.edit, doc(w, "doc-managers"))
    assert not edit.allow and edit.reason is not None and "read-only" in edit.reason


async def test_mirror_replaces_and_forget_removes(world: World) -> None:
    w = world
    await w.authz.mirror(
        acl(w.source, "doc-managers", entry(AclPrincipalKind.group, w.ids["managers"])), space_id=w.space
    )
    assert not await w.can("bob", Permission.read, doc(w, "doc-managers"))
    assert await w.can("alice", Permission.read, doc(w, "doc-managers"))
    await w.authz.forget(w.source, "doc-managers")
    assert not await w.can("alice", Permission.read, doc(w, "doc-managers"))
    assert await w.authz.graph.read("document", document_object_id(w.source, "doc-managers")) == []


async def test_folder_inheritance(world: World) -> None:
    w = world
    await w.authz.mirror(acl(w.source, "folder", entry(AclPrincipalKind.user, w.ids["carol"])), space_id=w.space)
    await w.authz.mirror(acl(w.source, "folder/report.docx", parent="folder"), space_id=w.space)
    assert await w.can("carol", Permission.read, doc(w, "folder/report.docx"))
    assert not await w.can("bob", Permission.read, doc(w, "folder/report.docx"))


async def test_mirroring_into_an_unknown_space_fails(world: World) -> None:
    with pytest.raises(LookupError):
        await world.authz.mirror(acl(world.source, "x"), space_id=new_id("space"))


# ------------------------------------------------------------------ spaces


async def test_space_roles(world: World) -> None:
    w = world
    space = ResourceRef(type=ResourceType.space, id=w.space)
    finance = ResourceRef(type=ResourceType.space, id=w.finance_space)
    assert await w.can("carol", Permission.read, space)
    assert not await w.can("carol", Permission.comment, space)
    assert await w.can("bob", Permission.comment, space)  # editor implies comment
    assert not await w.can("bob", Permission.verify, space)
    assert await w.can("alice", Permission.admin, space)
    assert await w.can("alice", Permission.publish, space)
    assert not await w.can("dave", Permission.discover, space)
    assert await w.can("alice", Permission.read, finance)
    assert not await w.can("bob", Permission.read, finance)
    tenant = ResourceRef(type=ResourceType.tenant, id=w.tenant)
    assert await w.can("bob", Permission.read, tenant)
    assert not await w.can("bob", Permission.admin, tenant)
    assert not await w.can("bob", Permission.read, ResourceRef(type=ResourceType.tenant, id=new_id("tenant")))


# ------------------------------------------------------------------ derived knowledge


async def _claims(w: World) -> dict[str, str]:
    """Claims backed by doc-managers, doc-all, both doc-managers and doc-company, and one
    derived from the first two."""
    out = {}
    versions = {}
    for ext in ("doc-managers", "doc-all", "doc-company"):
        sv, spans = w.kb.source_version([f"{ext}: 住宿标准每晚600元。"], external_id=ext)
        versions[ext] = (sv, spans)
        async with w.store.transaction() as tx:
            await tx.put_source_version(sv, spans)
    for name, exts in {"mgr": ["doc-managers"], "all": ["doc-all"], "mixed": ["doc-managers", "doc-company"]}.items():
        claim, _ = w.kb.claim(f"claim {name}")
        evidence = [
            w.kb.claim(claim.statement, versions[e][1][0])[1][0].model_copy(update={"claim_id": claim.id}) for e in exts
        ]
        async with w.store.transaction() as tx:
            await tx.upsert_claims([claim], evidence)
        out[name] = claim.id
    derived, _ = w.kb.claim("derived")
    async with w.store.transaction() as tx:
        await tx.upsert_claims(
            [derived],
            [],
            [
                ClaimDerivation(
                    claim_id=derived.id, from_claim_ids=[out["mgr"], out["all"]], method=DerivationMethod.merge
                )
            ],
        )
    out["derived"] = derived.id
    out.update({f"sv:{e}": v[0].id for e, v in versions.items()})
    return out


async def test_claims_are_readable_only_through_readable_sources(world: World) -> None:
    w = world
    c = await _claims(w)

    def claim(name: str) -> ResourceRef:
        return ResourceRef(type=ResourceType.claim, id=c[name])

    assert await w.can("alice", Permission.read, claim("mgr"))
    assert not await w.can("carol", Permission.read, claim("mgr"))
    assert await w.can("carol", Permission.read, claim("all"))
    assert not await w.can("dave", Permission.read, claim("all"))  # not in the space either

    for name, versions in (("alice", ["doc-managers"]), ("bob", ["doc-company", "doc-managers"])):
        decision = await w.authz.can_read_derived(w.who(name), c["mixed"])
        assert decision.allow and decision.readable_support == sorted(c[f"sv:{v}"] for v in versions)
    hidden = await w.authz.can_read_derived(w.who("carol"), c["mixed"])
    assert not hidden.allow and hidden.readable_support == []  # nothing named, nothing counted

    carol_derived = await w.authz.can_read_derived(w.who("carol"), c["derived"])
    assert carol_derived.allow and carol_derived.readable_support == [c["sv:doc-all"]]
    assert await w.can("carol", Permission.read, claim("derived"))
    assert not await w.can("carol", Permission.comment, claim("all"))  # a space viewer cannot comment

    decisions = await w.authz.check_many(w.who("carol"), Permission.read, [claim("mgr"), claim("all")])
    assert [d.allow for d in decisions] == [False, True]


# ------------------------------------------------------------------ agents


async def test_agents_act_with_the_persons_rights_cut_to_their_scope(world: World) -> None:
    w = world
    space = ResourceRef(type=ResourceType.space, id=w.space)
    assert await w.can(w.agent("bob"), Permission.read, space)
    assert not await w.can(w.agent("bob"), Permission.comment, space)  # read-only by default
    assert await w.can(w.agent("bob", agent_scopes=[Permission.read, Permission.comment]), Permission.comment, space)
    assert not await w.can(w.agent("carol", agent_scopes=[Permission.comment]), Permission.comment, space)
    assert not await w.can(w.agent("bob", space_scope=[w.finance_space]), Permission.read, space)
    assert not await w.can(w.agent("carol"), Permission.read, doc(w, "doc-managers"))
    orphan = Principal(id=new_id("agent"), kind=PrincipalKind.agent, tenant_id=w.tenant)
    with pytest.raises(PermissionError):
        await w.authz.check(orphan, Permission.read, space)


# ------------------------------------------------------------------ index pre-filter


async def test_scope_filter_matches_chunk_tokens(world: World) -> None:
    w = world
    alice = await w.authz.scope_filter(w.who("alice"), Permission.read)
    assert sorted(alice.space_ids) == sorted([w.space, w.finance_space])
    assert {w.ids["alice"], w.ids["finance"], w.ids["managers"], f"tenant:{w.tenant}"} <= set(alice.principal_tokens)
    assert alice.max_sensitivity == SensitivityLabel.internal
    bob = await w.authz.scope_filter(w.who("bob"), Permission.read)
    assert {w.ids["sales"], w.ids["company"]} <= set(bob.principal_tokens)
    carol = await w.authz.scope_filter(w.who("carol"), Permission.read)
    assert carol.max_sensitivity == SensitivityLabel.confidential
    dave = await w.authz.scope_filter(w.who("dave"), Permission.read)
    assert dave.space_ids == [] and dave.max_sensitivity == SensitivityLabel.public

    snapshot = acl(w.source, "doc-managers", entry(AclPrincipalKind.group, w.ids["managers"]))
    tokens = set(acl_tokens(snapshot, w.tenant))
    assert tokens == {w.ids["managers"], f"system:{w.tenant}"}
    assert tokens & set(alice.principal_tokens) and not tokens & set(carol.principal_tokens)

    svc = await w.authz.scope_filter(w.who("svc"), Permission.read)
    assert svc.principal_tokens == [f"system:{w.tenant}"] and svc.max_sensitivity == SensitivityLabel.secret
    assert w.space in svc.space_ids

    agent = await w.authz.scope_filter(w.agent("alice", space_scope=[w.space]), Permission.read)
    assert agent.space_ids == [w.space]
    blocked = await w.authz.scope_filter(w.agent("alice"), Permission.edit)
    assert blocked.space_ids == [] and blocked.principal_tokens == []


def test_acl_tokens_for_open_documents() -> None:
    tenant = new_id("tenant")
    snapshot = acl(
        new_id("source"),
        "x",
        entry(AclPrincipalKind.anyone_in_tenant),
        entry(AclPrincipalKind.anyone_with_link),
        entry(AclPrincipalKind.public),
        entry(AclPrincipalKind.user, None),
    )
    assert acl_tokens(snapshot, tenant) == sorted([f"system:{tenant}", f"tenant:{tenant}", f"link:{tenant}", "public"])


def test_document_ids_are_valid_spicedb_ids() -> None:
    assert document_object_id("src_1", "folder/doc-1") == "src_1|folder/doc-1"
    odd = document_object_id("src_1", "报告 2026.docx")
    assert odd.startswith("src_1|=") and all(ch.isascii() and (ch.isalnum() or ch in "|/_-=+") for ch in odd)
    assert document_object_id("src_1", "=x") != "src_1|=x"


async def test_memory_graph_rejects_tuples_the_schema_forbids() -> None:
    g = MemoryGraph()
    with pytest.raises(ValueError, match="not allowed"):
        await g.write([Rel(Obj("group", "grp_x"), "member", Subject("tenant", "ten_x"))])
    with pytest.raises(ValueError, match="no relation"):
        await g.write([Rel(Obj("space", "spc_x"), "approver", Subject("user", "usr_x"))])


# ------------------------------------------------------------------ events


async def test_acl_changed_events_are_mirrored(world: World) -> None:
    from inspiration.authz.handlers import AclChangedHandler
    from inspiration.contracts import EventType, new_event
    from inspiration.contracts.models import AclChanged
    from inspiration.eventbus import InMemoryBus

    w = world
    bus = InMemoryBus()
    bus.subscribe(EventType.ACL_CHANGED, "m13", AclChangedHandler(w.authz))
    snapshot = acl(w.source, "doc-new", entry(AclPrincipalKind.user, w.ids["carol"]))
    changed = AclChanged(
        source_id=w.source,
        external_id="doc-new",
        space_id=w.space,
        acl_hash=snapshot.acl_hash,
        fidelity=snapshot.fidelity,
        snapshot=snapshot,
    )
    await bus.publish(new_event(changed, tenant_id=w.tenant, producer="m2.sync"))
    # A large ACL travels through the store instead of the event.
    stored = acl(w.source, "doc-stored", entry(AclPrincipalKind.user, w.ids["dave"]))
    async with w.store.transaction() as tx:
        await tx.put_acl_snapshot(stored)
    by_ref = changed.model_copy(update={"external_id": "doc-stored", "acl_hash": stored.acl_hash, "snapshot": None})
    await bus.publish(new_event(by_ref, tenant_id=w.tenant, producer="m2.sync"))
    missing = changed.model_copy(update={"external_id": "doc-unknown", "snapshot": None})
    await bus.publish(new_event(missing, tenant_id=w.tenant, producer="m2.sync"))
    await bus.drain()
    assert await w.can("carol", Permission.read, doc(w, "doc-new"))
    assert await w.can("dave", Permission.read, doc(w, "doc-stored"))
    assert [e.data["external_id"] for e, _ in bus.dead_letters("m13") if e] == ["doc-unknown"]
