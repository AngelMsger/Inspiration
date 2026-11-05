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
 * Each version gets its governance level: the item's (front matter, folder defaults,
 * document properties), else the source's, else reference.
 *
 * The stored blob is the NormalizedDocument without its ACL: blocks for structured sources,
 * a file reference for the parser router, or a process snapshot. Normalization reads it.
 * ACL entries are mapped to engine principals with the resolver the business layer provides;
 * unmapped principals are kept without principal_id and denied by access control.
 *
 * The Documents tree: documents(tenant, space) lists a space's documents with their latest
 * versions, and documentTree() folds the ones a reader may open into one node per source,
 * with its folders (the source's own path, else the external ID's) and documents. A folder
 * with nothing left in it is never built, so a reader never learns it exists.
 *
 * Uploads (uploads.ts): each space has one upload area, a source of type "upload" whose ID
 * follows from the space's (uploadAreaId), created with the space's first file
 * (uploadArea). upload(area, file) keeps the bytes as a blob, records the file in
 * sync.uploads and stores it as the item at its path, at once: the document is in the tree
 * when upload returns, and reading follows from document.fetched as for any source. The same
 * bytes at the same path change nothing; other bytes make a new version. Uploads start as
 * reference and carry no ACL, so the space's audience decides who reads them. Planned is
 * removing an upload.
 */

export { MIGRATIONS } from "./migrations.ts";
export {
  COMPONENT,
  ITEMS,
  type ItemOutcome,
  type ItemState,
  itemKey,
  type ListedDocument,
  type PrincipalResolver,
  SOURCES,
  SourceSync,
  type SourceSyncOptions,
  type SyncReport,
} from "./sync.ts";
export { documentTree, entryOf, foldersOf } from "./tree.ts";
export { MAX_PATH, pathParts, UPLOAD_TYPE, UPLOADS, type Upload, type UploadRecord, uploadAreaId } from "./uploads.ts";
