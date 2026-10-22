"""M13's event handlers. Subscribe with consumer group "m13":

consumer.subscribe(EventType.ACL_CHANGED, "m13", AclChangedHandler(service))
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from inspiration.contracts import payload_of
from inspiration.contracts.models import AclChanged, AclSnapshot, EventEnvelope

from .service import AuthzService

log = logging.getLogger(__name__)

type SnapshotFetcher = Callable[[str, str], Awaitable[AclSnapshot | None]]


class AclChangedHandler:
    """Mirror the new ACL. Mirroring is idempotent, so redelivery is harmless. A snapshot
    whose hash differs from the event's is older or newer than the event; it is mirrored
    anyway, since it is what the source says now."""

    def __init__(self, service: AuthzService, *, fetch: SnapshotFetcher | None = None) -> None:
        self.service = service
        self.fetch = fetch

    async def __call__(self, event: EventEnvelope) -> None:
        changed = payload_of(event, AclChanged)
        snapshot = changed.snapshot
        if snapshot is None and self.fetch is not None:
            snapshot = await self.fetch(changed.source_id, changed.external_id)
        if snapshot is None:
            # Left pending: the consumer retries and finally dead-letters it for a person to see.
            raise LookupError(f"acl.changed for {changed.source_id}:{changed.external_id} has no snapshot")
        if snapshot.acl_hash != changed.acl_hash:
            log.info(
                "mirroring %s:%s with a different ACL than the event named", changed.source_id, changed.external_id
            )
        await self.service.mirror(snapshot, space_id=changed.space_id)
