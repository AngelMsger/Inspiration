/**
 * From DocBlocks (a connector's or a parser's tree) to the SourceBlocks and Spans of one
 * version. Blocks come out flat in reading order with a parent link and the heading path
 * above them; a table keeps one block per row, and the row's cells are its spans.
 */

import {
  contentHash,
  type DocBlock,
  type DocBlockKind,
  type SourceBlock,
  type SourceVersion,
  type Span,
  type SpanLocator,
  stableId,
} from "@inspiration/contracts";
import { passages } from "./sentences.ts";

/** A block before it has its final ID. */
export interface Draft {
  kind: DocBlockKind;
  anchor: string;
  text: string;
  headingPath: string[];
  parent?: number;
  level?: number;
  page?: number;
  bbox?: [number, number, number, number];
  fieldKey?: string;
  attrs?: Record<string, unknown>;
  /** A table row's cells, with their offsets in the row's text. */
  cells?: { row?: number; col: number; start: number; end: number }[];
}

const NO_SPANS = new Set<DocBlockKind>(["heading", "table", "page_break"]);
const WHOLE = new Set<DocBlockKind>(["code", "formula"]);

/** Blocks in reading order. Page breaks are dropped; table cells fold into their rows. */
export function flatten(blocks: readonly DocBlock[]): Draft[] {
  const out: Draft[] = [];
  const headings: { level: number; text: string }[] = [];
  const path = () => headings.map((h) => h.text);

  const row = (b: DocBlock, parent: number, index: number): void => {
    const cells = b.kind === "table_row" ? (b.children ?? []) : [b];
    let text = "";
    const located: NonNullable<Draft["cells"]> = [];
    cells.forEach((c, col) => {
      if (col > 0) text += "\t";
      const cellText = cellTextOf(c);
      located.push({
        row: c.cell?.row ?? b.cell?.row ?? index,
        col: c.cell?.col ?? col,
        start: text.length,
        end: text.length + cellText.length,
      });
      text += cellText;
    });
    const d: Draft = { kind: "table_row", anchor: b.anchor, text, headingPath: path(), parent, cells: located };
    if (b.page !== undefined) d.page = b.page;
    out.push(d);
  };

  const visit = (b: DocBlock, parent?: number): void => {
    if (b.kind === "page_break") return;
    if (b.kind === "heading") {
      const level = b.level ?? 1;
      while (headings.length && (headings.at(-1) as { level: number }).level >= level) headings.pop();
    }
    const d: Draft = { kind: b.kind, anchor: b.anchor, text: (b.text ?? "").trim(), headingPath: path() };
    if (parent !== undefined) d.parent = parent;
    if (b.level !== undefined) d.level = b.level;
    if (b.page !== undefined) d.page = b.page;
    if (b.bbox) d.bbox = b.bbox;
    if (b.field_key) d.fieldKey = b.field_key;
    if (b.attrs && Object.keys(b.attrs).length) d.attrs = b.attrs;
    if (b.image) d.attrs = { ...d.attrs, image: b.image };
    if (b.kind === "table") {
      const index = out.push(d) - 1;
      const rows = b.children ?? [];
      // Cells straight under the table, without rows, are grouped by their row number.
      const grouped = rows.every((r) => r.kind === "table_cell") ? groupCells(rows) : rows;
      grouped.forEach((r, i) => {
        row(r, index, i);
      });
      d.text = out
        .slice(index + 1)
        .map((r) => r.text)
        .join("\n");
      return;
    }
    const empty = !d.text && b.kind !== "image" && !b.children?.length;
    if (empty) return;
    const index = d.text || b.kind === "image" ? out.push(d) - 1 : parent;
    if (b.kind === "heading" && d.text) headings.push({ level: b.level ?? 1, text: d.text });
    for (const c of b.children ?? []) visit(c, index);
  };

  for (const b of blocks) visit(b);
  return out;
}

function cellTextOf(cell: DocBlock): string {
  const own = (cell.text ?? "").trim();
  const nested = (cell.children ?? []).map(cellTextOf).filter(Boolean);
  return [own, ...nested].filter(Boolean).join("\n");
}

function groupCells(cells: readonly DocBlock[]): DocBlock[] {
  const rows = new Map<number, DocBlock[]>();
  cells.forEach((c, i) => {
    const r = c.cell?.row ?? i;
    rows.set(r, [...(rows.get(r) ?? []), c]);
  });
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([r, children]) => ({
      anchor: `${children[0]?.anchor ?? "row"}:row`,
      kind: "table_row",
      cell: { row: r },
      children,
    }));
}

/**
 * IDs before alignment. Native anchors (a source's own block IDs) are the identity; other
 * blocks are identified by their place in the outline and their text, with a counter for
 * repeats, so an unchanged block keeps its ID wherever it moves.
 */
export function draftIds(drafts: readonly Draft[], doc: { sourceId: string; externalId: string }, native: boolean) {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    if (native) return stableId("source_block", doc.sourceId, doc.externalId, d.anchor);
    const key = [d.kind, d.headingPath.join("\x1e"), d.text].join("\x1f");
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return stableId("source_block", doc.sourceId, doc.externalId, key, String(n));
  });
}

/** The version's blocks and spans, given each draft's final ID. */
export function build(
  drafts: readonly Draft[],
  ids: readonly string[],
  version: SourceVersion,
): { blocks: SourceBlock[]; spans: Span[] } {
  const blocks: SourceBlock[] = [];
  const spans: Span[] = [];
  drafts.forEach((d, i) => {
    const id = ids[i] as string;
    const block: SourceBlock = {
      id,
      tenant_id: version.tenant_id,
      source_version_id: version.id,
      kind: d.kind,
      anchor: d.anchor,
      text: d.text,
      text_hash: contentHash(d.text),
      ordinal: i,
      span_ids: [],
    };
    if (d.parent !== undefined) block.parent_id = ids[d.parent] as string;
    if (d.level !== undefined) block.level = d.level;
    if (d.headingPath.length) block.heading_path = d.headingPath;
    if (d.page !== undefined) block.page = d.page;
    if (d.attrs) block.attrs = d.attrs;
    const seen = new Map<string, number>();
    for (const [text, locator] of spanTexts(d)) {
      const n = seen.get(text) ?? 0;
      seen.set(text, n + 1);
      const span: Span = {
        id: stableId("span", id, text, String(n)),
        tenant_id: version.tenant_id,
        source_version_id: version.id,
        block_id: id,
        locator,
        text,
        text_hash: contentHash(text),
        ordinal: spans.length,
      };
      block.span_ids.push(span.id);
      spans.push(span);
    }
    blocks.push(block);
  });
  return { blocks, spans };
}

function spanTexts(d: Draft): [string, SpanLocator][] {
  if (NO_SPANS.has(d.kind) || !d.text) return [];
  const base = (kind: SpanLocator["kind"], start: number, end: number): SpanLocator => {
    const l: SpanLocator = { block_anchor: d.anchor, kind, char_start: start, char_end: end };
    if (d.page !== undefined) l.page = d.page;
    if (d.bbox) l.bbox = d.bbox;
    return l;
  };
  if (d.cells) {
    return d.cells.flatMap((c) =>
      passages(d.text.slice(c.start, c.end)).map((p): [string, SpanLocator] => {
        const l = base("table_cell", c.start + p.start, c.start + p.end);
        l.cell = { col: c.col, ...(c.row !== undefined && { row: c.row }) };
        return [p.text, l];
      }),
    );
  }
  if (d.kind === "form_field") {
    const l = base("form_field", 0, d.text.length);
    if (d.fieldKey) l.field_key = d.fieldKey;
    return [[d.text, l]];
  }
  if (WHOLE.has(d.kind)) return [[d.text, base("block", 0, d.text.length)]];
  return passages(d.text).map((p) => [p.text, base("text_range", p.start, p.end)]);
}
