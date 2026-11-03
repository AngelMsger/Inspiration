/** CSV as one table; the first row is taken as the header. */

import type { DocBlock, FileMeta, ParseResult, Parser } from "@inspiration/contracts";
import { parse } from "csv-parse/sync";
import { decode, producer } from "./parser.ts";

export function parseCsv(text: string): DocBlock[] {
  const rows = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  if (!rows.length) return [];
  return [
    {
      anchor: "table",
      kind: "table",
      attrs: { header_rows: 1 },
      children: rows.map((row, r) => ({
        anchor: `r${r + 1}`,
        kind: "table_row",
        cell: { row: r },
        children: row.map((text, c) => ({
          anchor: `r${r + 1}c${c + 1}`,
          kind: "table_cell",
          text,
          cell: { row: r, col: c },
        })),
      })),
    },
  ];
}

export const csvParser: Parser = {
  name: "csv",
  version: "1",
  accepts: (meta: FileMeta) => (meta.mime_type === "text/csv" || /\.csv$/i.test(meta.filename ?? "") ? 1 : 0),
  async parse(file, _meta, _hints, ctx): Promise<ParseResult> {
    return { blocks: parseCsv(decode(await ctx.blobs.get(file))), parser: producer(this) };
  },
};
