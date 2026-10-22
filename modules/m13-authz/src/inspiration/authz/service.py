"""M13 permission service: AuthZ and AclMirror over a relationship graph.

Rules, in one place:

* Source documents keep the ACL of the system they came from. Unmapped and external
  principals in a source ACL get nothing.
* Spaces hold Inspiration roles: viewer < commenter < editor < steward / owner.
* Derived knowledge (claims, pages, SOPs) is readable only through source documents the
  viewer can read now, found by walking lineage. Hidden support is never counted or named.
* An agent acts on behalf of a person: its rights are the person's, cut down to its
  agent_scopes (read and discover when absent) and its space_scope.
* Search indexes get an IndexFilter (spaces, principal tokens, clearance) so ranking only
  ever sees rows the viewer may read; results are still re-checked before they leave.
"""

from __future__ import annotations

import asyncio
import base64
import re
from collections.abc import Awaitable, Callable, Sequence

from inspiration.contracts import kind_of
from inspiration.contracts.interfaces import KnowledgeStore
from inspiration.contracts.models import (
    AclPrincipalKind,
    AclRole,
    AclSnapshot,
    Decision,
    DerivedReadDecision,
    IndexFilter,
    Permission,
    Principal,
    PrincipalKind,
    ResourceRef,
    ResourceType,
    SensitivityLabel,
)

from .graph import Graph, Obj, Rel, Subject

READ_ONLY = frozenset({Permission.discover, Permission.read})
LINEAGE_DEPTH = 6
_SAFE_ID = re.compile(r"[a-zA-Z0-9/_\-+][a-zA-Z0-9/_\-=+]{0,899}")  # SpiceDB's ID alphabet, no leading "="
DOCUMENT_ROLES = {
    AclRole.viewer: "viewer",
    AclRole.commenter: "commenter",
    AclRole.editor: "editor",
    AclRole.owner: "owner",
}
SPACE_ROLES = ("owner", "steward", "editor", "commenter", "viewer")

type SpaceResolver = Callable[[ResourceRef], Awaitable[str | None]]


# ---------------------------------------------------------------- IDs and tokens


def document_object_id(source_id: str, external_id: str) -> str:
    """SpiceDB object ID of a source document. External IDs outside SpiceDB's ID alphabet
    are base64url-encoded behind a "=", which a plain ID never starts with."""
    if _SAFE_ID.fullmatch(external_id):
        return f"{source_id}|{external_id}"
    encoded = base64.urlsafe_b64encode(external_id.encode("utf-8")).decode().rstrip("=")
    return f"{source_id}|={encoded}"


def document_ref(source_id: str, external_id: str) -> ResourceRef:
    return ResourceRef(type=ResourceType.document, id=f"{source_id}:{external_id}")


def subject_of(principal_id: str) -> Subject:
    """Graph subject for a canonical principal ID: users and services directly, groups and
    departments as their member sets, a tenant as everyone in it."""
    kind = kind_of(principal_id)
    if kind == "user":
        return Subject("user", principal_id)
    if kind == "service":
        return Subject("service", principal_id)
    if kind == "group":
        return Subject("group", principal_id, "member")
    if kind == "department":
        return Subject("department", principal_id, "member")
    if kind == "tenant":
        return Subject("tenant", principal_id, "member")
    raise ValueError(f"{principal_id} cannot hold a permission directly")


def acl_tokens(snapshot: AclSnapshot, tenant_id: str) -> list[str]:
    """Principal tokens for chunk.acl_tokens (written by M4), matching scope_filter's
    principal_tokens. Every chunk also carries system:<tenant> for service principals."""
    tokens = {f"system:{tenant_id}"}
    for e in snapshot.entries:
        match e.principal_kind:
            case AclPrincipalKind.user | AclPrincipalKind.group | AclPrincipalKind.department:
                if e.principal_id:
                    tokens.add(e.principal_id)
            case AclPrincipalKind.tenant | AclPrincipalKind.anyone_in_tenant:
                tokens.add(f"tenant:{tenant_id}")
            case AclPrincipalKind.anyone_with_link:
                tokens.add(f"link:{tenant_id}")
            case AclPrincipalKind.public:
                tokens.add("public")
    return sorted(tokens)


# ---------------------------------------------------------------- the service


class AuthzService:
    def __init__(self, graph: Graph, store: KnowledgeStore, *, spaces: SpaceResolver | None = None) -> None:
        self.graph = graph
        self.store = store
        self.extra_spaces = spaces

    # ------------------------------------------------------ directory and spaces (admin writes)

    async def add_tenant_member(self, tenant_id: str, principal_id: str) -> None:
        await self.graph.write([Rel(Obj("tenant", tenant_id), "member", subject_of(principal_id))])

    async def add_tenant_admin(self, tenant_id: str, user_id: str) -> None:
        await self.graph.write([Rel(Obj("tenant", tenant_id), "admin", subject_of(user_id))])

    async def add_service(self, tenant_id: str, service_id: str) -> None:
        await self.graph.write([Rel(Obj("tenant", tenant_id), "service", subject_of(service_id))])

    async def grant_clearance(self, tenant_id: str, principal_id: str, label: SensitivityLabel) -> None:
        relation = {SensitivityLabel.confidential: "confidential_reader", SensitivityLabel.secret: "secret_reader"}
        if label not in relation:
            raise ValueError("clearance above internal is granted as confidential or secret")
        await self.graph.write([Rel(Obj("tenant", tenant_id), relation[label], subject_of(principal_id))])

    async def add_member(self, container_id: str, member_id: str) -> None:
        """Add a user or nested group to a group, or a user or sub-department to a department."""
        kind = kind_of(container_id)
        if kind not in ("group", "department"):
            raise ValueError(f"{container_id} is not a group or department")
        await self.graph.write([Rel(Obj(kind, container_id), "member", subject_of(member_id))])

    async def remove_member(self, container_id: str, member_id: str) -> None:
        await self.graph.write(delete=[Rel(Obj(kind_of(container_id), container_id), "member", subject_of(member_id))])

    async def create_space(self, space_id: str, *, tenant_id: str, owner_id: str, parent_id: str | None = None) -> None:
        rels = [
            Rel(Obj("space", space_id), "tenant", Subject("tenant", tenant_id)),
            Rel(Obj("space", space_id), "owner", subject_of(owner_id)),
        ]
        if parent_id:
            rels.append(Rel(Obj("space", space_id), "parent", Subject("space", parent_id)))
        await self.graph.write(rels)

    async def grant_space(self, space_id: str, role: str, principal_id: str) -> None:
        if role not in SPACE_ROLES:
            raise ValueError(f"unknown space role {role!r}")
        await self.graph.write([Rel(Obj("space", space_id), role, subject_of(principal_id))])

    async def revoke_space(self, space_id: str, role: str, principal_id: str) -> None:
        await self.graph.write(delete=[Rel(Obj("space", space_id), role, subject_of(principal_id))])

    async def register_source(self, source_id: str, space_id: str) -> None:
        await self.graph.write([Rel(Obj("source", source_id), "space", Subject("space", space_id))])

    # ------------------------------------------------------ AclMirror

    async def mirror(self, snapshot: AclSnapshot, *, space_id: str) -> None:
        """Make the document's relationships equal to the snapshot, in one atomic write."""
        tenants = await self.graph.read("space", space_id, "tenant")
        if not tenants:
            raise LookupError(f"space {space_id} is not registered")
        tenant_id = tenants[0].subject.id
        source, doc = snapshot.source_id, Obj("document", document_object_id(snapshot.source_id, snapshot.external_id))
        desired = {Rel(doc, "source", Subject("source", source))}
        if snapshot.inherits_from_external_id:
            parent = document_object_id(source, snapshot.inherits_from_external_id)
            desired.add(Rel(doc, "parent", Subject("document", parent)))
        everyone = Subject("tenant", tenant_id, "member")
        for e in snapshot.entries:
            match e.principal_kind:
                case AclPrincipalKind.user | AclPrincipalKind.group | AclPrincipalKind.department:
                    if e.principal_id is None:
                        continue  # unmapped principals are denied
                    expected = {"user": "usr", "group": "grp", "department": "dep"}[e.principal_kind.value]
                    if not e.principal_id.startswith(expected + "_"):
                        continue
                    desired.add(Rel(doc, DOCUMENT_ROLES[e.role], subject_of(e.principal_id)))
                case AclPrincipalKind.tenant | AclPrincipalKind.anyone_in_tenant:
                    desired.add(Rel(doc, "viewer", everyone))
                case AclPrincipalKind.anyone_with_link:
                    desired.add(Rel(doc, "link_viewer", everyone))
                case AclPrincipalKind.public:
                    desired.add(Rel(doc, "public_viewer", Subject("user", "*")))
                case AclPrincipalKind.external:
                    continue
        existing = set(await self.graph.read("document", doc.id))
        await self.graph.write(
            touch=[*sorted(desired - existing), Rel(Obj("source", source), "space", Subject("space", space_id))],
            delete=sorted(existing - desired),
        )

    async def forget(self, source_id: str, external_id: str) -> None:
        existing = await self.graph.read("document", document_object_id(source_id, external_id))
        await self.graph.write(delete=existing)

    # ------------------------------------------------------ AuthZ

    def _acting_subject(self, who: Principal) -> Subject:
        if who.kind == PrincipalKind.agent:
            if who.on_behalf_of is None:
                raise PermissionError("an agent principal must act on behalf of a person")
            return subject_of(who.on_behalf_of)
        if who.kind in (PrincipalKind.user, PrincipalKind.service):
            return subject_of(who.id)
        raise PermissionError(f"a {who.kind.value} principal cannot make requests")

    @staticmethod
    def _agent_limits(who: Principal, perm: Permission) -> str | None:
        if who.kind != PrincipalKind.agent:
            return None
        scopes = set(who.agent_scopes) if who.agent_scopes is not None else READ_ONLY
        if perm not in scopes:
            return f"the agent is not granted {perm.value}"
        return None

    async def space_of(self, res: ResourceRef) -> str | None:
        match res.type:
            case ResourceType.space:
                return res.id
            case ResourceType.claim:
                claims = await self.store.get_claims([res.id])
                return claims[0].space_id if claims else None
            case ResourceType.page:
                page = await self.store.get_page(res.id)
                return page.spec.space_id if page else None
            case ResourceType.source:
                rels = await self.graph.read("source", res.id, "space")
                return rels[0].subject.id if rels else None
            case ResourceType.document:
                source_id = res.id.split(":", 1)[0]
                rels = await self.graph.read("source", source_id, "space")
                return rels[0].subject.id if rels else None
        return await self.extra_spaces(res) if self.extra_spaces else None

    async def check(self, who: Principal, perm: Permission, res: ResourceRef) -> Decision:
        if (limit := self._agent_limits(who, perm)) is not None:
            return Decision(allow=False, reason=limit)
        subject = self._acting_subject(who)
        if res.type == ResourceType.tenant:
            if res.id != who.tenant_id:
                return Decision(allow=False, reason="another tenant")
            allowed = await self.graph.check(
                Obj("tenant", res.id), "administer" if perm == Permission.admin else "everyone", subject
            )
            return self._decision(allowed)
        space_id = await self.space_of(res)
        if who.kind == PrincipalKind.agent and who.space_scope is not None and space_id not in who.space_scope:
            return Decision(allow=False, reason="outside the agent's space scope")
        if res.type == ResourceType.document:
            if perm not in READ_ONLY:
                return Decision(allow=False, reason="source documents are read-only in Inspiration")
            source_id, _, external_id = res.id.partition(":")
            doc = Obj("document", document_object_id(source_id, external_id))
            return self._decision(await self.graph.check(doc, "read", subject))
        if res.type == ResourceType.source:
            permission = "admin" if perm == Permission.admin else "read" if perm in READ_ONLY else None
            if permission is None:
                return Decision(allow=False, reason=f"{perm.value} does not apply to a source")
            return self._decision(await self.graph.check(Obj("source", res.id), permission, subject))
        if space_id is None:
            return Decision(allow=False, reason=f"unknown {res.type.value} {res.id}")
        if not await self.graph.check(Obj("space", space_id), perm.value, subject):
            return Decision(allow=False, reason=f"no {perm.value} permission on the space")
        if res.type in (ResourceType.claim, ResourceType.sop, ResourceType.knowledge_model, ResourceType.entity):
            derived = await self.can_read_derived(who, res.id)
            if not derived.allow:
                return Decision(allow=False, reason="no readable source supports it")
        return self._decision(True)

    def _decision(self, allowed: bool) -> Decision:
        return Decision(allow=allowed, reason=None if allowed else "no permission", consistency_token=self.graph.token)

    async def check_many(self, who: Principal, perm: Permission, resources: Sequence[ResourceRef]) -> list[Decision]:
        return list(await asyncio.gather(*(self.check(who, perm, r) for r in resources)))

    async def principal_tokens(self, who: Principal) -> list[str]:
        subject = self._acting_subject(who)
        if subject.type == "service":
            member = await self.graph.check(Obj("tenant", who.tenant_id), "system", subject)
            return [f"system:{who.tenant_id}"] if member else []
        groups, departments = await asyncio.gather(
            self.graph.lookup("group", "member", subject), self.graph.lookup("department", "member", subject)
        )
        tokens = [subject.id, *groups, *departments, "public"]
        if await self.graph.check(Obj("tenant", who.tenant_id), "everyone", subject):
            tokens += [f"tenant:{who.tenant_id}", f"link:{who.tenant_id}"]
        return sorted(set(tokens))

    async def clearance(self, who: Principal) -> SensitivityLabel:
        subject = self._acting_subject(who)
        tenant = Obj("tenant", who.tenant_id)
        secret, confidential, member = await self.graph.check_many(
            [(tenant, "clear_secret"), (tenant, "clear_confidential"), (tenant, "everyone")], subject
        )
        if secret:
            return SensitivityLabel.secret
        if confidential:
            return SensitivityLabel.confidential
        if member or subject.type == "service":
            return SensitivityLabel.internal
        return SensitivityLabel.public

    async def scope_filter(self, who: Principal, perm: Permission) -> IndexFilter:
        if self._agent_limits(who, perm) is not None:
            return IndexFilter(space_ids=[], principal_tokens=[], max_sensitivity=SensitivityLabel.public)
        subject = self._acting_subject(who)
        spaces, tokens, clearance = await asyncio.gather(
            self.graph.lookup("space", perm.value, subject), self.principal_tokens(who), self.clearance(who)
        )
        if who.kind == PrincipalKind.agent and who.space_scope is not None:
            spaces = [s for s in spaces if s in set(who.space_scope)]
        return IndexFilter(space_ids=spaces, principal_tokens=tokens, max_sensitivity=clearance)

    async def can_read_derived(self, who: Principal, unit_id: str) -> DerivedReadDecision:
        """Readable when at least one source version behind the unit belongs to a document
        the viewer can read now. readable_support lists only those source versions."""
        subject = self._acting_subject(who)
        graph = await self.store.lineage(unit_id, depth=LINEAGE_DEPTH)
        version_ids = sorted({n.id for n in graph.nodes if kind_of(n.id) == "source_version"})
        versions = [v for v in await asyncio.gather(*(self.store.get_source_version(i) for i in version_ids)) if v]
        docs = [Obj("document", document_object_id(v.source_id, v.external_id)) for v in versions]
        allowed = await self.graph.check_many([(d, "read") for d in docs], subject) if docs else []
        readable = [v.id for v, ok in zip(versions, allowed, strict=True) if ok]
        return DerivedReadDecision(allow=bool(readable), readable_support=readable)
