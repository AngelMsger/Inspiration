/**
 * Connectors: one plugin per source type in the "connectors" group, each a
 * ConnectorFactory(source, context). Source sync drives them; a connector lists items with
 * their version hashes, fetches one item as a NormalizedDocument and reads its ACL. It never
 * stores anything itself.
 *
 * - folder: a local or mounted directory. Files go to the parser router; front matter and
 *   .meta.yaml give title, approval state, sensitivity and other metadata, .acl.yaml gives
 *   permissions per folder, and a language in the file name ("leave.zh.md") makes a file a
 *   translation of the one without it (DocumentMetadata.translation_of). A Markdown file whose
 *   front matter is not valid YAML is listed, but fetching it fails (FrontMatterError) rather
 *   than fall back to the folder's labels, so sync keeps its earlier version and reports it.
 * - confluence: Data Center / Server space pages through REST with PAT authentication.
 * - feishu.docx: Feishu documents as blocks anchored by native block IDs, with members and
 *   link sharing as the ACL for fixtures; live docx/wiki links use the connection-scoped view.
 * - feishu.approval: Feishu approval definitions and instance timelines, for SOP mining.
 *
 * Feishu docx reads through FeishuApi, either fixtures or the live app-authenticated API.
 * Live document listing only enumerates configured targets; resolving wiki links and reading
 * revision-pinned blocks happens in fetch, so one failed document cannot stop its neighbours.
 * Wiki targets keep a wiki:<token> identity even when their docx target changes.
 * Approval imports still use fixtures. ACL entries carry the source's own principal
 * IDs; mapping them to engine principals is source sync's job.
 */

export { aclHash, aclSnapshot, normalizeEntries, parseEntry } from "./acl.ts";
export * from "./confluence.ts";
export * from "./feishu/api.ts";
export { FeishuApprovalConnector, feishuApprovalConnector, processSnapshot } from "./feishu/approval.ts";
export { docBlocks, FeishuDocxConnector, feishuDocxConnector, memberEntries, plainText } from "./feishu/docx.ts";
export { feishuLink } from "./feishu/http.ts";
export {
  FolderConnector,
  FrontMatterError,
  folderConnector,
  frontMatter,
  globToRegExp,
  MIME_TYPES,
  translationOf,
} from "./folder.ts";
export * from "./http.ts";
