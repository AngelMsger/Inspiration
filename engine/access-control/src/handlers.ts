/**
 * Access control's event handlers. Subscribe with the consumer group "access-control":
 *
 *     consumer.subscribe("acl.changed", "access-control", aclChangedHandler(service));
 */

import { type EventHandler, payloadOf } from "@inspiration/contracts";
import type { AuthzService } from "./service.ts";

/**
 * Mirror the ACL the event names: inline in the event when small, otherwise read from the
 * knowledge store, where source sync stored it in the same transaction as the event.
 * Mirroring is idempotent, so redelivery is harmless.
 */
export function aclChangedHandler(service: AuthzService): EventHandler {
  return async (event) => {
    const changed = payloadOf(event, "acl.changed");
    const snapshot =
      changed.snapshot ??
      (await service.store.getAclSnapshot(changed.source_id, changed.external_id, changed.acl_hash));
    if (!snapshot) {
      // A bug upstream, not an outage: the consumer retries, then dead-letters it.
      throw new RangeError(`no ACL snapshot ${changed.acl_hash} for ${changed.source_id}:${changed.external_id}`);
    }
    await service.mirror(snapshot, { spaceId: changed.space_id });
  };
}
