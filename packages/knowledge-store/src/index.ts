/**
 * The knowledge store: the only component that reads or writes kb.* tables.
 *
 *     const store = new PostgresStore(pool); // or new MemoryStore() in component tests
 *     await store.transaction(async (tx) => {
 *       await tx.putSourceVersion(version, spans);
 *       await tx.upsertClaims(claims, evidence);
 *       await tx.publish(newEvent("claims.updated", payload, options)); // commits with the data
 *     });
 *
 * slot(tenant, key) reads one fact slot from every claim whose slot key (slotOf: its own
 * slot_key, else its subject, predicate and qualifiers) is that key: its variants
 * (the values current claims state, with counts and up to five representatives) and its
 * versions (every value stated, from when the system first knew it to when the last claim
 * stating it closed).
 *
 * Test data builders are in "@inspiration/knowledge-store/testing".
 */

export { BaseStore, claimField, LABEL_CHARS, rowsHash, type StoreOptions } from "./base.ts";
export { HNSW_DIMS, MemoryKeywordIndex, MemoryVectorIndex, PgSearchIndex, PgVectorIndex, terms } from "./indexes.ts";
export { type Embedding, MemoryStore, type MemoryStoreOptions, MemoryTx } from "./memory.ts";
export { MIGRATIONS } from "./migrations.ts";
export { PgTx, PostgresStore, searchText, vectorLiteral, writeEmbeddings } from "./postgres.ts";
export { type AsOf, matches, QUERY_LIMIT, toSql } from "./query.ts";
export { IntegrityError } from "./rules.ts";
export { factSlot, REPRESENTATIVES } from "./slots.ts";
