"""M13: identity and permissions.

service = AuthzService(SpiceDBGraph(connect(endpoint, key)), store)   # or MemoryGraph() in tests
await service.mirror(acl_snapshot, space_id=...)                     # on acl.changed
flt = await service.scope_filter(principal, Permission.read)          # pushed into search indexes
"""

from .graph import Graph, MemoryGraph, Obj, Rel, Subject, schema_text
from .service import AuthzService, acl_tokens, document_object_id, document_ref, subject_of
from .spicedb import SpiceDBGraph, connect, write_schema

__all__ = [
    "AuthzService",
    "Graph",
    "MemoryGraph",
    "Obj",
    "Rel",
    "SpiceDBGraph",
    "Subject",
    "acl_tokens",
    "connect",
    "document_object_id",
    "document_ref",
    "schema_text",
    "subject_of",
    "write_schema",
]
