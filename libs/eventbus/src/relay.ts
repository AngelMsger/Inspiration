/**
 * The outbox relay: forwards committed outbox rows to the transport, in order.
 *
 * Only one relay is active per database (it holds an advisory lock); extra replicas wait as
 * hot standbys. It wakes on NOTIFY from the outbox trigger and also polls, so a lost
 * notification only delays delivery by pollIntervalMs.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { EventEnvelope } from "@inspiration/contracts";
import { connect, logger, type Queryable } from "@inspiration/kernel";
import type pg from "pg";
import type { Transport } from "./transport.ts";

const log = logger("eventbus.relay");

export const RELAY_LOCK = 0x1a50002;

const SELECT_PENDING = `
SELECT seq, envelope FROM bus.outbox
WHERE relayed_at IS NULL
ORDER BY seq
LIMIT $1
FOR UPDATE SKIP LOCKED`;

const PRUNE_EVERY_MS = 3_600_000;

export interface RelayOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  /** How long relayed rows are kept, for debugging and replay. */
  retentionMs?: number;
}

export class OutboxRelay {
  readonly databaseUrl: string;
  readonly transport: Transport;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly retentionMs: number;
  #stopping = new AbortController();

  constructor(databaseUrl: string, transport: Transport, options: RelayOptions = {}) {
    this.databaseUrl = databaseUrl;
    this.transport = transport;
    this.batchSize = options.batchSize ?? 500;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000;
  }

  /** Forward one batch. Returns how many events were sent. */
  async relayOnce(client: Queryable): Promise<number> {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query<{ seq: number; envelope: EventEnvelope }>(SELECT_PENDING, [this.batchSize]);
      if (rows.length) {
        // Sent before the rows are stamped: a crash in between re-sends, which consumers
        // tolerate, and never loses an event.
        await this.transport.send(rows.map((r) => r.envelope));
        await client.query("UPDATE bus.outbox SET relayed_at = now() WHERE seq = ANY($1)", [rows.map((r) => r.seq)]);
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }

  /** Forward everything pending now. */
  async drain(client: Queryable): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.relayOnce(client);
      total += n;
      if (n < this.batchSize) return total;
    }
  }

  async prune(client: Queryable): Promise<number> {
    const result = await client.query(
      "DELETE FROM bus.outbox WHERE relayed_at < now() - make_interval(secs => $1::double precision)",
      [this.retentionMs / 1000],
    );
    return result.rowCount ?? 0;
  }

  /** Relay until stop() is called. */
  async run(): Promise<void> {
    this.#stopping = new AbortController();
    const { signal } = this.#stopping;
    const listen = await connect(this.databaseUrl);
    const work = await connect(this.databaseUrl);
    try {
      while (!signal.aborted) {
        const { rows } = await listen.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
          RELAY_LOCK,
        ]);
        if (rows[0]?.locked) break;
        log.info("another relay is active; standing by");
        await sleep(5_000, undefined, { signal }).catch(() => undefined);
      }
      if (signal.aborted) return;
      await listen.query("LISTEN inspiration_outbox");
      log.info("relay active");
      let lastPrune = 0;
      while (!signal.aborted) {
        const sent = await this.drain(work);
        if (sent) log.debug("relayed events", { count: sent });
        if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
          await this.prune(work);
          lastPrune = Date.now();
        }
        await this.#wait(listen, signal);
      }
    } finally {
      await Promise.allSettled([listen.end(), work.end()]);
    }
  }

  /** Until a NOTIFY arrives, pollIntervalMs passes, or stop() is called. */
  async #wait(listen: pg.Client, signal: AbortSignal): Promise<void> {
    const notified = new AbortController();
    const wake = () => notified.abort();
    listen.once("notification", wake);
    try {
      // AbortSignal.any is aborted already when stop() came in while the relay was busy.
      await sleep(this.pollIntervalMs, undefined, { signal: AbortSignal.any([signal, notified.signal]) }).catch(
        () => undefined,
      );
    } finally {
      listen.removeListener("notification", wake);
    }
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
  }
}
