/**
 * Normalization turns every fetched source version into SourceBlocks and Spans in the
 * knowledge store and publishes blocks.changed, so later stages redo only what changed.
 *
 * - Where blocks come from: a connector's own structure (Feishu blocks, approval
 *   definitions), or the parser router for files. The router asks every "parsers" plugin
 *   how well it accepts the file and uses the best; the built-in ones read Markdown, plain
 *   text, HTML and CSV, and the parsing worker adds Office, PDF and scans behind the same
 *   contract.
 * - Blocks: flat in reading order, with the heading path above each block and a parent
 *   link; a table keeps one block per row, its cells being the row's spans. Headings have
 *   no spans of their own.
 * - Spans: sentences, and in Chinese text also clauses ended by "；", cut at a comma when
 *   longer than 400 characters; whole code blocks; one per table cell or form field. A
 *   span's ID depends on its block's ID and its text only.
 * - Stable IDs: a source's native block ID when it has one. Otherwise the block's place
 *   in the outline and its text, then aligned with the previous version so that an edited
 *   paragraph keeps its ID and counts as changed (see diff.ts). Unchanged sentences in a
 *   changed block keep their span IDs.
 * - Diffs are taken against the version normalization last stored for the document. A
 *   version whose file cannot be parsed is noted and does not replace it; a version that
 *   changed only metadata reuses its predecessor's blocks without parsing; a tombstone
 *   removes every block.
 * - Duplicates: exact (equal normalized text) and near (SimHash within 6 of 64 bits, for
 *   documents of 200 characters or more) among the tenant's current documents, reported in
 *   blocks.changed.
 *
 * Normalization keeps its own state (the last stored version per document and the
 * fingerprint index) in the normalization schema. Delivery is at least once: a version is
 * normalized once, and a redelivered event finds it done.
 */

export { build, type Draft, draftIds, flatten } from "./blocks.ts";
export { align, type BlockDiff, blockDiff, SAME_BLOCK, similarity } from "./diff.ts";
export {
  bands,
  type Fingerprint,
  fingerprint,
  hamming,
  MIN_NEAR_TEXT,
  MIN_TEXT,
  NEAR,
  normalizedText,
} from "./fingerprint.ts";
export { MIGRATIONS } from "./migrations.ts";
export {
  COMPONENT,
  DOCUMENTS,
  type DocumentState,
  type DocumentStatus,
  documentKey,
  FINGERPRINTS,
  Normalization,
  type NormalizationOptions,
  type NormalizeResult,
  processBlocks,
} from "./normalize.ts";
export { csvParser, parseCsv } from "./parsers/csv.ts";
export { htmlParser, parseHtml } from "./parsers/html.ts";
export { markdownParser, parseMarkdown } from "./parsers/markdown.ts";
export { parseText, textParser } from "./parsers/text.ts";
export { MAX_PASSAGE, type Passage, passages } from "./sentences.ts";
