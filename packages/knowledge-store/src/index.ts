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
 * Test data builders are in "@inspiration/knowledge-store/testing".
 */

export { BaseStore, claimField, LABEL_CHARS, rowsHash, type StoreOptions } from "./base.ts";
export { HNSW_DIMS, MemoryKeywordIndex, MemoryVectorIndex, PgSearchIndex, PgVectorIndex, terms } from "./indexes.ts";
export { type Embedding, MemoryStore, type MemoryStoreOptions, MemoryTx } from "./memory.ts";
export { MIGRATIONS } from "./migrations.ts";
export { PgTx, PostgresStore, searchText, vectorLiteral, writeEmbeddings } from "./postgres.ts";
export { type AsOf, matches, QUERY_LIMIT, toSql } from "./query.ts";
export { IntegrityError } from "./rules.ts";
