"""SpiceDB backend for the relationship graph, and the schema apply command.

Reads after this process's own writes use at_least_as_fresh with the last ZedToken it
received, so a check right after a mirror sees the new ACL; other reads use SpiceDB's
default cache-friendly consistency.

Usage: inspiration-authz-schema [--endpoint localhost:50051] [--insecure]
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence
from typing import Any

import grpc
from authzed.api.v1 import (
    AsyncClient,
    CheckBulkPermissionsRequest,
    CheckBulkPermissionsRequestItem,
    CheckPermissionRequest,
    CheckPermissionResponse,
    Consistency,
    LookupResourcesRequest,
    LookupResourcesResponse,
    ObjectReference,
    ReadRelationshipsRequest,
    Relationship,
    RelationshipFilter,
    RelationshipUpdate,
    SubjectReference,
    WriteRelationshipsRequest,
    WriteSchemaRequest,
    ZedToken,
)
from grpcutil import bearer_token_credentials, insecure_bearer_token_credentials

from .graph import Obj, Rel, Subject, schema_text

HAS = CheckPermissionResponse.PERMISSIONSHIP_HAS_PERMISSION
# LookupResources has its own enum, where HAS_PERMISSION is 1, not 2.
LOOKUP_HAS = (
    LookupResourcesResponse.DESCRIPTOR.fields_by_name["permissionship"]
    .enum_type.values_by_name["LOOKUP_PERMISSIONSHIP_HAS_PERMISSION"]
    .number
)
BULK_CHUNK = 500


def connect(endpoint: str, key: str, *, insecure: bool = True) -> AsyncClient:
    creds = insecure_bearer_token_credentials(key) if insecure else bearer_token_credentials(key)
    return AsyncClient(endpoint, creds)


def _obj(o: Obj) -> ObjectReference:
    return ObjectReference(object_type=o.type, object_id=o.id)


def _subject(s: Subject) -> SubjectReference:
    return SubjectReference(
        object=ObjectReference(object_type=s.type, object_id=s.id), optional_relation=s.relation or ""
    )


def _rel(r: Rel) -> Relationship:
    return Relationship(resource=_obj(r.resource), relation=r.relation, subject=_subject(r.subject))


def _from_pb(r: Any) -> Rel:
    s = r.subject
    return Rel(
        Obj(r.resource.object_type, r.resource.object_id),
        r.relation,
        Subject(s.object.object_type, s.object.object_id, s.optional_relation or None),
    )


class SpiceDBGraph:
    def __init__(self, client: AsyncClient) -> None:
        self.client = client
        self.token: str | None = None

    def _consistency(self) -> Consistency:
        if self.token is None:
            return Consistency(minimize_latency=True)
        return Consistency(at_least_as_fresh=ZedToken(token=self.token))

    async def write(self, touch: Sequence[Rel] = (), delete: Sequence[Rel] = ()) -> str | None:
        updates = [
            RelationshipUpdate(operation=RelationshipUpdate.OPERATION_DELETE, relationship=_rel(r)) for r in delete
        ]
        updates += [
            RelationshipUpdate(operation=RelationshipUpdate.OPERATION_TOUCH, relationship=_rel(r)) for r in touch
        ]
        if not updates:
            return self.token
        resp = await self.client.WriteRelationships(WriteRelationshipsRequest(updates=updates))
        self.token = resp.written_at.token
        return self.token

    async def read(self, resource_type: str, resource_id: str | None = None, relation: str | None = None) -> list[Rel]:
        flt = RelationshipFilter(
            resource_type=resource_type, optional_resource_id=resource_id or "", optional_relation=relation or ""
        )
        stream = self.client.ReadRelationships(
            ReadRelationshipsRequest(consistency=self._consistency(), relationship_filter=flt)
        )
        return sorted([_from_pb(r.relationship) async for r in stream])

    async def check(self, resource: Obj, permission: str, subject: Subject) -> bool:
        resp = await self.client.CheckPermission(
            CheckPermissionRequest(
                consistency=self._consistency(),
                resource=_obj(resource),
                permission=permission,
                subject=_subject(subject),
            )
        )
        return bool(resp.permissionship == HAS)

    async def check_many(self, items: Sequence[tuple[Obj, str]], subject: Subject) -> list[bool]:
        out: list[bool] = []
        for start in range(0, len(items), BULK_CHUNK):
            batch = items[start : start + BULK_CHUNK]
            resp = await self.client.CheckBulkPermissions(
                CheckBulkPermissionsRequest(
                    consistency=self._consistency(),
                    items=[
                        CheckBulkPermissionsRequestItem(resource=_obj(o), permission=p, subject=_subject(subject))
                        for o, p in batch
                    ],
                )
            )
            for pair in resp.pairs:
                if pair.HasField("error"):
                    raise RuntimeError(f"SpiceDB bulk check failed: {pair.error.message}")
                out.append(pair.item.permissionship == HAS)
        return out

    async def lookup(self, resource_type: str, permission: str, subject: Subject) -> list[str]:
        stream = self.client.LookupResources(
            LookupResourcesRequest(
                consistency=self._consistency(),
                resource_object_type=resource_type,
                permission=permission,
                subject=_subject(subject),
            )
        )
        return sorted({r.resource_object_id async for r in stream if r.permissionship == LOOKUP_HAS})


async def write_schema(client: AsyncClient, schema: str | None = None) -> str:
    resp = await client.WriteSchema(WriteSchemaRequest(schema=schema or schema_text()))
    return str(resp.written_at.token)


async def _apply(endpoint: str, key: str, insecure: bool) -> str:
    # The gRPC channel must be created inside the running event loop.
    return await write_schema(connect(endpoint, key, insecure=insecure))


def main() -> int:
    from inspiration.kernel.settings import get_settings

    settings = get_settings()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--endpoint", default=settings.spicedb_endpoint)
    parser.add_argument("--insecure", action="store_true", default=settings.spicedb_insecure)
    args = parser.parse_args()
    try:
        token = asyncio.run(_apply(args.endpoint, settings.spicedb_key.get_secret_value(), args.insecure))
    except grpc.RpcError as e:
        print(f"schema write failed: {e}", file=sys.stderr)
        return 1
    print(f"schema written at {token}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
