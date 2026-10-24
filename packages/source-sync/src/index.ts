/**
 * Source sync: keeps the knowledge store in step with every connected source.
 *
 *     const sync = new SourceSync({ store, records, blobs, resolvePrincipal });
 *     await sync.addSource(source);   // the business layer registers sources and their spaces
 *     await sync.sync(source.id);     // a poll or the nightly reconcile
 *     bus.subscribe("source.changed", "source-sync", sync.onSourceChanged);
 *
 * A sync lists the source and compares each item's version hashes with what it stored last
 * (sync.items). For a new or changed item it fetches the document, keeps it as a blob and
 * writes, in one knowledge-store transaction, the new source version, the ACL snapshot and
 * the events: document.fetched when content or metadata changed, acl.changed when the ACL
 * did. A permission change alone writes no new version, so nothing is re-parsed or
 * re-embedded. Items gone from the listing get a tombstone version (deleted: true).
 *
 * The stored blob is the NormalizedDocument without its ACL: blocks for structured sources,
 * a file reference for the parser router, or a process snapshot. Normalization reads it.
 * ACL entries are mapped to engine principals with the resolver the business layer provides;
 * unmapped principals are kept without principal_id and denied by access control.
 */

export { MIGRATIONS } from "./migrations.ts";
export {
  COMPONENT,
  ITEMS,
  type ItemOutcome,
  type ItemState,
  itemKey,
  type PrincipalResolver,
  SOURCES,
  SourceSync,
  type SourceSyncOptions,
  type SyncReport,
} from "./sync.ts";
