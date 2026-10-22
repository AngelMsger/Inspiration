"""The relationship graph M13 reasons over, with two backends: SpiceDB (spicedb.py) and an
in-memory evaluator of the same schema.zed for module tests (MemoryGraph)."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from importlib import resources
from typing import Protocol


@dataclass(frozen=True, order=True)
class Obj:
    type: str
    id: str

    def __str__(self) -> str:
        return f"{self.type}:{self.id}"


@dataclass(frozen=True, order=True)
class Subject:
    type: str
    id: str  # "*" for a wildcard such as user:*
    relation: str | None = None  # "member" for group#member

    def __str__(self) -> str:
        return f"{self.type}:{self.id}" + (f"#{self.relation}" if self.relation else "")


@dataclass(frozen=True, order=True)
class Rel:
    resource: Obj
    relation: str
    subject: Subject

    def __str__(self) -> str:
        return f"{self.resource}#{self.relation}@{self.subject}"


class Graph(Protocol):
    token: str | None  # consistency token of the last write, when the backend has one

    async def write(self, touch: Sequence[Rel] = (), delete: Sequence[Rel] = ()) -> str | None:
        """Apply all updates atomically. Returns a consistency token when the backend has one."""
        ...

    async def read(
        self, resource_type: str, resource_id: str | None = None, relation: str | None = None
    ) -> list[Rel]: ...

    async def check(self, resource: Obj, permission: str, subject: Subject) -> bool: ...

    async def check_many(self, items: Sequence[tuple[Obj, str]], subject: Subject) -> list[bool]: ...

    async def lookup(self, resource_type: str, permission: str, subject: Subject) -> list[str]:
        """IDs of every resource of the type on which subject has the permission."""
        ...


def schema_text() -> str:
    return resources.files("inspiration.authz").joinpath("schema.zed").read_text(encoding="utf-8")


# ---------------------------------------------------------------- in-memory evaluator


@dataclass(frozen=True)
class _Definition:
    relations: dict[str, list[Subject]]  # allowed subject types (id "" = any, "*" = wildcard)
    permissions: dict[str, list[tuple[str, str | None]]]  # union of (name, arrow target)


_COMMENTS = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)
_DEFINITION = re.compile(r"definition\s+(\w+)\s*\{(.*?)\}", re.S)
_RELATION = re.compile(r"relation\s+(\w+)\s*:\s*([^\n]+)")
_PERMISSION = re.compile(r"permission\s+(\w+)\s*=\s*([^\n]+)")


def parse_schema(text: str) -> dict[str, _Definition]:
    """Parse the subset of the SpiceDB schema language schema.zed uses: relations with
    subject types, usersets and wildcards; permissions that are unions of relations,
    permissions and arrows. Intersections and exclusions are rejected."""
    out: dict[str, _Definition] = {}
    for name, body in _DEFINITION.findall(_COMMENTS.sub("", text)):
        relations: dict[str, list[Subject]] = {}
        for rel, types in _RELATION.findall(body):
            allowed = []
            for t in types.split("|"):
                t = t.strip()
                if t.endswith(":*"):
                    allowed.append(Subject(t[:-2], "*"))
                elif "#" in t:
                    typ, sub = t.split("#")
                    allowed.append(Subject(typ, "", sub))
                else:
                    allowed.append(Subject(t, ""))
            relations[rel] = allowed
        permissions: dict[str, list[tuple[str, str | None]]] = {}
        for perm, expr in _PERMISSION.findall(body):
            if "&" in expr or " - " in expr or "(" in expr:
                raise ValueError(f"{name}.{perm}: only unions are supported by the in-memory evaluator")
            terms = []
            for term in expr.split("+"):
                term = term.strip()
                left, _, right = term.partition("->")
                terms.append((left.strip(), right.strip() or None))
            permissions[perm] = terms
        out[name] = _Definition(relations, permissions)
    return out


class MemoryGraph:
    """Evaluates schema.zed in Python with SpiceDB's semantics for unions, arrows,
    usersets and wildcards. Tuples are validated against the schema like SpiceDB does."""

    def __init__(self, schema: str | None = None) -> None:
        self.schema = parse_schema(schema or schema_text())
        self.rels: set[Rel] = set()
        self.token: str | None = None

    def _validate(self, r: Rel) -> None:
        d = self.schema.get(r.resource.type)
        if d is None or r.relation not in d.relations:
            raise ValueError(f"{r}: {r.resource.type} has no relation {r.relation}")
        s = r.subject
        for allowed in d.relations[r.relation]:
            if allowed.type != s.type:
                continue
            if allowed.id == "*" and s.id == "*" and s.relation is None:
                return
            if allowed.id == "" and s.id != "*" and allowed.relation == s.relation:
                return
        raise ValueError(f"{r}: subject type not allowed on {r.resource.type}#{r.relation}")

    async def write(self, touch: Sequence[Rel] = (), delete: Sequence[Rel] = ()) -> str | None:
        for r in touch:
            self._validate(r)
        self.rels.difference_update(delete)
        self.rels.update(touch)
        return None

    async def read(self, resource_type: str, resource_id: str | None = None, relation: str | None = None) -> list[Rel]:
        return sorted(
            r
            for r in self.rels
            if r.resource.type == resource_type
            and (resource_id is None or r.resource.id == resource_id)
            and (relation is None or r.relation == relation)
        )

    def _has(self, obj: Obj, name: str, subject: Subject, seen: frozenset[tuple[Obj, str]]) -> bool:
        key = (obj, name)
        if key in seen:
            return False
        seen = seen | {key}
        d = self.schema.get(obj.type)
        if d is None:
            return False
        if name in d.relations:
            for r in self.rels:
                if r.resource != obj or r.relation != name:
                    continue
                s = r.subject
                if s == subject or (s.id == "*" and s.type == subject.type and subject.relation is None):
                    return True
                if s.relation is not None and self._has(Obj(s.type, s.id), s.relation, subject, seen):
                    return True
            return False
        for left, arrow in d.permissions.get(name, []):
            if arrow is None:
                if self._has(obj, left, subject, seen):
                    return True
                continue
            for r in self.rels:
                if (
                    r.resource == obj
                    and r.relation == left
                    and self._has(Obj(r.subject.type, r.subject.id), arrow, subject, seen)
                ):
                    return True
        return False

    async def check(self, resource: Obj, permission: str, subject: Subject) -> bool:
        return self._has(resource, permission, subject, frozenset())

    async def check_many(self, items: Sequence[tuple[Obj, str]], subject: Subject) -> list[bool]:
        return [self._has(o, p, subject, frozenset()) for o, p in items]

    async def lookup(self, resource_type: str, permission: str, subject: Subject) -> list[str]:
        ids = {r.resource.id for r in self.rels if r.resource.type == resource_type}
        return sorted(i for i in ids if self._has(Obj(resource_type, i), permission, subject, frozenset()))
