/** Plain text: paragraphs are separated by blank lines. */

import type { DocBlock, FileMeta, ParseResult, Parser } from "@inspiration/contracts";
import { decode, producer } from "./parser.ts";

export function parseText(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let lines: string[] = [];
  let first = 0;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) blocks.push({ anchor: `L${first}`, kind: "paragraph", text: body });
    lines = [];
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) flush();
    else {
      if (!lines.length) first = i + 1;
      lines.push(line);
    }
  });
  flush();
  return blocks;
}

export const textParser: Parser = {
  name: "text",
  version: "1",
  accepts: (meta: FileMeta) => (meta.mime_type === "text/plain" ? 1 : meta.mime_type.startsWith("text/") ? 0.2 : 0),
  async parse(file, _meta, _hints, ctx): Promise<ParseResult> {
    return { blocks: parseText(decode(await ctx.blobs.get(file))), parser: producer(this) };
  },
};
