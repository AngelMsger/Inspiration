/**
 * Component-owned record tables whose writes commit together with their events.
 *
 * A component that keeps state of its own (source sync's items, freshness states,
 * collaboration todos) declares each table once and gets the same API on Postgres and in
 * memory. Like the knowledge store's tables, a table keeps the whole record in `doc` and
 * copies the fields it filters on into columns. The component's own migration creates it:
 *
 *     CREATE TABLE sync.items (key text PRIMARY KEY, source_id text NOT NULL, doc jsonb NOT NULL);
 *
 *     const ITEMS = defineTable<Item>("sync.items", {
 *       key: (i) => `${i.source_id}:${i.external_id}`,
 *       columns: { source_id: (i) => i.source_id },
 *     });
 *     await records.transaction(async (tx) => {
 *       if (!(await tx.firstDelivery("source-sync", event.id))) return; // handled before
 *       await tx.put(ITEMS, [item]);
 *       await tx.publish(next); // commits with the rows
 *     });
 *     const items = await records.find(ITEMS, { source_id: sourceId }, { orderBy: "key" });
 *
 * Ordering by text compares bytes (COLLATE "C"), the order the in-memory tables use.
 */

import type { EventEnvelope, EventPublisher } from "@inspiration/contracts";
import { type Pool, type PoolClient, type Queryable, withTransaction } from "@inspiration/kernel";
import { firstDelivery } from "./inbox.ts";
import { writeOutbox } from "./outbox.ts";

export type Scalar = string | number | boolean;
export type Column<T> = (row: T) => Scalar | null | undefined;

/** The Postgres type of a column; text unless declared. */
export type ColumnType = "text" | "integer" | "double precision" | "boolean" | "timestamptz";

export interface Table<T> {
  /** "schema.table". */
  readonly name: string;
  readonly key: (row: T) => string;
  /** Columns the table copies out of each record, for find and ordering. */
  readonly columns: Readonly<Record<string, Column<T>>>;
  readonly types: Readonly<Record<string, ColumnType>>;
}

const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const COLUMN = /^[a-z][a-z0-9_]*$/;

export function defineTable<T>(
  name: string,
  spec: {
    key: (row: T) => string;
    columns?: Readonly<Record<string, Column<T>>>;
    types?: Readonly<Record<string, ColumnType>>;
  },
): Table<T> {
  if (!NAME.test(name)) throw new RangeError(`table name must be schema.table, not ${JSON.stringify(name)}`);
  const columns = spec.columns ?? {};
  for (const c of Object.keys(columns)) {
    if (!COLUMN.test(c) || c === "key" || c === "doc") throw new RangeError(`${name}: bad column name ${c}`);
  }
  const types: Record<string, ColumnType> = {};
  for (const c of Object.keys(columns)) types[c] = spec.types?.[c] ?? "text";
  for (const c of Object.keys(spec.types ?? {})) if (!(c in columns)) throw new RangeError(`${name}: no column ${c}`);
  return { name, key: spec.key, columns, types };
}

/** Column equality filters. An array matches any of its values; null matches a missing value. */
export type Where = Readonly<Record<string, Scalar | null | readonly Scalar[]>>;

export interface FindOptions {
  /** A column name, or "key". Defaults to "key". */
  orderBy?: string;
  descending?: boolean;
  limit?: number;
}

export interface RecordReader {
  get<T>(table: Table<T>, key: string): Promise<T | undefined>;
  /** Records in the order of keys, skipping unknown ones. */
  getMany<T>(table: Table<T>, keys: readonly string[]): Promise<T[]>;
  find<T>(table: Table<T>, where?: Where, options?: FindOptions): Promise<T[]>;
  count<T>(table: Table<T>, where?: Where): Promise<number>;
}

export interface RecordTx extends RecordReader {
  /** Insert or replace records by key. */
  put<T>(table: Table<T>, rows: readonly T[]): Promise<void>;
  delete<T>(table: Table<T>, keys: readonly string[]): Promise<void>;
  /** Publish with the transaction: the events are sent only if it commits. */
  publish(...events: EventEnvelope[]): Promise<void>;
  /** False when this group already handled the event; the mark commits with the transaction. */
  firstDelivery(group: string, eventId: string): Promise<boolean>;
  /**
   * Hold a lock on the name until the transaction ends, so transactions that lock the same
   * name run one after another, across processes. Take it before reading what the
   * transaction will change.
   */
  lock(name: string): Promise<void>;
}

export interface Records extends RecordReader {
  transaction<R>(fn: (tx: RecordTx) => Promise<R>): Promise<R>;
}

function checkWhere(table: Table<unknown>, where: Where): void {
  for (const c of Object.keys(where)) {
    if (!(c in table.columns) && c !== "key") throw new RangeError(`${table.name} has no column ${c}`);
  }
}

function orderColumn(table: Table<unknown>, options: FindOptions): string {
  const c = options.orderBy ?? "key";
  if (c !== "key" && !(c in table.columns)) throw new RangeError(`${table.name} has no column ${c}`);
  return c;
}

// ---------------------------------------------------------------- memory

function columnValue<T>(table: Table<T>, row: T, column: string): Scalar | null {
  if (column === "key") return table.key(row);
  return (table.columns[column] as Column<T>)(row) ?? null;
}

function compare(a: Scalar | null, b: Scalar | null): number {
  if (a === b) return 0;
  if (a === null) return -1; // nulls sort first ascending and last descending, as in the SQL
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function matchesWhere<T>(table: Table<T>, row: T, where: Where): boolean {
  return Object.entries(where).every(([c, wanted]) => {
    const v = columnValue(table, row, c);
    if (Array.isArray(wanted)) return v !== null && wanted.includes(v);
    return v === wanted;
  });
}

type Tables = Map<string, Map<string, unknown>>;

class MemoryReader implements RecordReader {
  protected tables: () => Tables;

  constructor(tables: () => Tables) {
    this.tables = tables;
  }

  protected rows<T>(table: Table<T>): Map<string, T> {
    return (this.tables().get(table.name) ?? new Map()) as Map<string, T>;
  }

  async get<T>(table: Table<T>, key: string): Promise<T | undefined> {
    const row = this.rows(table).get(key);
    return row === undefined ? undefined : structuredClone(row);
  }

  async getMany<T>(table: Table<T>, keys: readonly string[]): Promise<T[]> {
    const rows = this.rows(table);
    return structuredClone(keys.flatMap((k) => (rows.has(k) ? [rows.get(k) as T] : [])));
  }

  async find<T>(table: Table<T>, where: Where = {}, options: FindOptions = {}): Promise<T[]> {
    checkWhere(table as Table<unknown>, where);
    const column = orderColumn(table as Table<unknown>, options);
    const found = [...this.rows(table).values()].filter((r) => matchesWhere(table, r, where));
    const sign = options.descending ? -1 : 1;
    found.sort(
      (a, b) =>
        sign * compare(columnValue(table, a, column), columnValue(table, b, column)) ||
        sign * compare(table.key(a), table.key(b)),
    );
    return structuredClone(options.limit === undefined ? found : found.slice(0, options.limit));
  }

  async count<T>(table: Table<T>, where: Where = {}): Promise<number> {
    checkWhere(table as Table<unknown>, where);
    let n = 0;
    for (const r of this.rows(table).values()) if (matchesWhere(table, r, where)) n++;
    return n;
  }
}

class MemoryRecordTx extends MemoryReader implements RecordTx {
  readonly events: EventEnvelope[] = [];
  readonly delivered: [string, string][] = [];
  readonly #store: MemoryRecords;
  readonly #copied = new Set<string>();
  #open = true;

  constructor(store: MemoryRecords, tables: Tables) {
    super(() => {
      if (!this.#open) throw new Error("the transaction has ended");
      return tables;
    });
    this.#store = store;
  }

  close(): void {
    this.#open = false;
  }

  /** The table's rows for writing: copied on first write, so a rollback leaves the original. */
  #writable<T>(table: Table<T>): Map<string, T> {
    const tables = this.tables();
    if (!this.#copied.has(table.name)) {
      tables.set(table.name, new Map(tables.get(table.name) ?? []));
      this.#copied.add(table.name);
    }
    return tables.get(table.name) as Map<string, T>;
  }

  async put<T>(table: Table<T>, rows: readonly T[]): Promise<void> {
    const target = this.#writable(table);
    for (const r of rows) target.set(table.key(r), structuredClone(r));
  }

  async delete<T>(table: Table<T>, keys: readonly string[]): Promise<void> {
    const target = this.#writable(table);
    for (const k of keys) target.delete(k);
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    this.tables();
    this.events.push(...structuredClone(events));
  }

  async firstDelivery(group: string, eventId: string): Promise<boolean> {
    this.tables();
    if (this.#store.wasDelivered(group, eventId) || this.delivered.some(([g, e]) => g === group && e === eventId)) {
      return false;
    }
    this.delivered.push([group, eventId]);
    return true;
  }

  async lock(_name: string): Promise<void> {
    this.tables(); // memory transactions already run one at a time
  }
}

/** In-memory Records for tests. Transactions run one at a time, like serializable ones. */
export class MemoryRecords extends MemoryReader implements Records {
  readonly publisher: EventPublisher | undefined;
  /** Events from committed transactions, in order. */
  readonly published: EventEnvelope[] = [];
  #tables: Tables = new Map();
  readonly #delivered = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { publisher?: EventPublisher } = {}) {
    super(() => this.#tables);
    this.publisher = options.publisher;
  }

  wasDelivered(group: string, eventId: string): boolean {
    return this.#delivered.has(`${group}\0${eventId}`);
  }

  async transaction<R>(fn: (tx: RecordTx) => Promise<R>): Promise<R> {
    const run = this.#queue.then(async () => {
      const tables: Tables = new Map(this.#tables);
      const tx = new MemoryRecordTx(this, tables);
      try {
        const result = await fn(tx);
        this.#tables = tables;
        for (const [g, e] of tx.delivered) this.#delivered.add(`${g}\0${e}`);
        this.published.push(...tx.events);
        return { result, events: tx.events };
      } finally {
        tx.close();
      }
    });
    this.#queue = run.catch(() => undefined);
    const { result, events } = await run;
    if (this.publisher && events.length) await this.publisher.publish(...events);
    return result;
  }
}

// ---------------------------------------------------------------- Postgres

function sqlWhere(table: Table<unknown>, where: Where, params: unknown[]): string {
  checkWhere(table, where);
  const clauses = Object.entries(where).map(([c, wanted]) => {
    if (wanted === null) return `${c} IS NULL`;
    params.push(wanted);
    const type = c === "key" ? "text" : (table.types[c] as ColumnType);
    return Array.isArray(wanted) ? `${c} = ANY($${params.length}::${type}[])` : `${c} = $${params.length}::${type}`;
  });
  return clauses.length ? clauses.join(" AND ") : "true";
}

/** Text sorts by bytes (COLLATE "C"), the order of the in-memory tables. */
function sortKey(table: Table<unknown>, column: string): string {
  return column === "key" || table.types[column] === "text" ? `${column} COLLATE "C"` : column;
}

class PgReader implements RecordReader {
  protected db: () => Queryable;

  constructor(db: () => Queryable) {
    this.db = db;
  }

  async get<T>(table: Table<T>, key: string): Promise<T | undefined> {
    const { rows } = await this.db().query<{ doc: T }>(`SELECT doc FROM ${table.name} WHERE key = $1`, [key]);
    return rows[0]?.doc;
  }

  async getMany<T>(table: Table<T>, keys: readonly string[]): Promise<T[]> {
    if (!keys.length) return [];
    const { rows } = await this.db().query<{ key: string; doc: T }>(
      `SELECT key, doc FROM ${table.name} WHERE key = ANY($1::text[])`,
      [keys],
    );
    const byKey = new Map(rows.map((r) => [r.key, r.doc]));
    return keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k) as T] : []));
  }

  async find<T>(table: Table<T>, where: Where = {}, options: FindOptions = {}): Promise<T[]> {
    const params: unknown[] = [];
    const clause = sqlWhere(table as Table<unknown>, where, params);
    const column = orderColumn(table as Table<unknown>, options);
    const dir = options.descending ? "DESC NULLS LAST" : "ASC NULLS FIRST";
    const keys = column === "key" ? ["key"] : [column, "key"];
    const orderSql = keys.map((c) => `${sortKey(table as Table<unknown>, c)} ${dir}`).join(", ");
    let sql = `SELECT doc FROM ${table.name} WHERE ${clause} ORDER BY ${orderSql}`;
    if (options.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await this.db().query<{ doc: T }>(sql, params);
    return rows.map((r) => r.doc);
  }

  async count<T>(table: Table<T>, where: Where = {}): Promise<number> {
    const params: unknown[] = [];
    const clause = sqlWhere(table as Table<unknown>, where, params);
    const { rows } = await this.db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table.name} WHERE ${clause}`,
      params,
    );
    return rows[0]?.n ?? 0;
  }
}

class PgRecordTx extends PgReader implements RecordTx {
  #open = true;

  constructor(client: PoolClient) {
    super(() => {
      if (!this.#open) throw new Error("the transaction has ended");
      return client;
    });
  }

  close(): void {
    this.#open = false;
  }

  async put<T>(table: Table<T>, rows: readonly T[]): Promise<void> {
    if (!rows.length) return;
    const columns = Object.keys(table.columns);
    const payload = rows.map((r) => {
      const out: Record<string, unknown> = { key: table.key(r), doc: r };
      for (const c of columns) out[c] = (table.columns[c] as Column<T>)(r) ?? null;
      return out;
    });
    // The record set's column types come from the table, so typed columns need no casts.
    const names = ["key", ...columns, "doc"];
    const updates = [...columns, "doc"].map((c) => `${c} = excluded.${c}`).join(", ");
    await this.db().query(
      `INSERT INTO ${table.name} (${names.join(", ")})
       SELECT ${names.join(", ")} FROM jsonb_populate_recordset(NULL::${table.name}, $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET ${updates}`,
      [JSON.stringify(payload)],
    );
  }

  async delete<T>(table: Table<T>, keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await this.db().query(`DELETE FROM ${table.name} WHERE key = ANY($1::text[])`, [keys]);
  }

  async publish(...events: EventEnvelope[]): Promise<void> {
    await writeOutbox(this.db(), events);
  }

  firstDelivery(group: string, eventId: string): Promise<boolean> {
    return firstDelivery(this.db(), group, eventId);
  }

  async lock(name: string): Promise<void> {
    await this.db().query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);
  }
}

export class PgRecords extends PgReader implements Records {
  readonly pool: Pool;

  constructor(pool: Pool) {
    super(() => pool);
    this.pool = pool;
  }

  transaction<R>(fn: (tx: RecordTx) => Promise<R>): Promise<R> {
    return withTransaction(this.pool, async (client) => {
      const tx = new PgRecordTx(client);
      try {
        return await fn(tx);
      } finally {
        tx.close();
      }
    });
  }
}
