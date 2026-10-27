/**
 * Connectors: one plugin per source type in the "connectors" group, each a
 * ConnectorFactory(source, context). Source sync drives them; a connector lists items with
 * their version hashes, fetches one item as a NormalizedDocument and reads its ACL. It never
 * stores anything itself.
 *
 * - folder: a local or mounted directory. Files go to the parser router; front matter and
 *   .meta.yaml give title, approval state, sensitivity and other metadata, .acl.yaml gives
 *   permissions per folder, and a language in the file name ("leave.zh.md") makes a file a
 *   translation of the one without it (DocumentMetadata.translation_of).
 * - feishu.docx: Feishu documents as blocks anchored by native block IDs, with members and
 *   link sharing as the ACL.
 * - feishu.approval: Feishu approval definitions and instance timelines, for SOP mining.
 *
 * The Feishu connectors read through FeishuApi; recorded fixtures stand in for the HTTP API
 * until a tenant gives the app credentials. ACL entries carry the source's own principal
 * IDs; mapping them to engine principals is source sync's job.
 */

export { aclHash, aclSnapshot, normalizeEntries, parseEntry } from "./acl.ts";
export * from "./feishu/api.ts";
export { FeishuApprovalConnector, feishuApprovalConnector, processSnapshot } from "./feishu/approval.ts";
export { docBlocks, FeishuDocxConnector, feishuDocxConnector, memberEntries, plainText } from "./feishu/docx.ts";
export { FolderConnector, folderConnector, frontMatter, globToRegExp, MIME_TYPES, translationOf } from "./folder.ts";
