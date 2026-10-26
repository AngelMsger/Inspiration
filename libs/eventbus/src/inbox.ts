/**
 * Exactly-once effects for handlers that write to Postgres:
 *
 *     await withTransaction(pool, async (client) => {
 *       if (!(await firstDelivery(client, "freshness", event.id))) return; // already handled
 *       // ... the handler's writes, committed together with the inbox row
 *     });
 */

import type { Queryable } from "@inspiration/kernel";

export async function firstDelivery(client: Queryable, group: string, eventId: string): Promise<boolean> {
  const result = await client.query(
    "INSERT INTO bus.inbox (consumer_group, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [group, eventId],
  );
  return result.rowCount === 1;
}
