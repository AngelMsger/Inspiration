"""M10: the knowledge store. The only module that reads or writes kb.* tables.

store = PostgresStore(pool)                 # or MemoryStore() in module tests
async with store.transaction() as tx:
    await tx.put_source_version(version, spans)
    await tx.upsert_claims(claims, evidence)
    await tx.publish(new_event(ClaimsUpdated(...), ...))   # commits with the data
"""

from inspiration.kernel.migrate import MigrationSet

from .base import BaseStore, claim_field
from .indexes import MemoryKeywordIndex, MemoryVectorIndex, PgSearchIndex, PgVectorIndex
from .memory import MemoryStore
from .postgres import PostgresStore
from .rules import IntegrityError

MIGRATIONS = MigrationSet(component="kb", package="inspiration.store", order=30)

__all__ = [
    "MIGRATIONS",
    "BaseStore",
    "IntegrityError",
    "MemoryKeywordIndex",
    "MemoryStore",
    "MemoryVectorIndex",
    "PgSearchIndex",
    "PgVectorIndex",
    "PostgresStore",
    "claim_field",
]
