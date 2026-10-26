/** Writing events to the transactional outbox. */

import type { EventEnvelope, EventPublisher } from "@inspiration/contracts";
import { type Pool, type Queryable, withTransaction } from "@inspiration/kernel";

const INSERT = `
INSERT INTO bus.outbox (event_id, event_type, tenant_id, subject, envelope)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
ON CONFLICT (event_id) DO NOTHING`;

/** Insert events using the caller's connection, inside the caller's transaction. */
export async function writeOutbox(client: Queryable, events: readonly EventEnvelope[]): Promise<void> {
  if (!events.length) return;
  await client.query(INSERT, [
    events.map((e) => e.id),
    events.map((e) => e.type),
    events.map((e) => e.tenant_id),
    events.map((e) => e.subject ?? null),
    events.map((e) => JSON.stringify(e)),
  ]);
}

/** EventPublisher for code that is not inside a store transaction. */
export class OutboxPublisher implements EventPublisher {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    await withTransaction(this.pool, (client) => writeOutbox(client, events));
  }
}
