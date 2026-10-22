"""M13's event handlers. Subscribe with consumer group "m13":

consumer.subscribe(EventType.ACL_CHANGED, "m13", AclChangedHandler(service))
"""

from __future__ import annotations

from inspiration.contracts import payload_of
from inspiration.contracts.models import AclChanged, EventEnvelope

from .service import AuthzService


class AclChangedHandler:
    """Mirror the ACL the event names: inline in the event when small, otherwise read from
    M10, where M2 stored it in the same transaction as the event. Mirroring is idempotent,
    so redelivery is harmless."""

    def __init__(self, service: AuthzService) -> None:
        self.service = service

    async def __call__(self, event: EventEnvelope) -> None:
        changed = payload_of(event, AclChanged)
        snapshot = changed.snapshot or await self.service.store.get_acl_snapshot(
            changed.source_id, changed.external_id, changed.acl_hash
        )
        if snapshot is None:
            # A bug upstream, not an outage: the consumer retries, then dead-letters it.
            raise LookupError(f"no ACL snapshot {changed.acl_hash} for {changed.source_id}:{changed.external_id}")
        await self.service.mirror(snapshot, space_id=changed.space_id)
