import type { DocBlock } from "@inspiration/contracts";

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

/** Split OCR Markdown into normalized blocks with page-scoped anchors ("p3-b0"). */
export function markdownToBlocks(text: string, page?: number): DocBlock[] {
  const blocks: DocBlock[] = [];
  const prefix = page ? `p${page}` : "p";
  const at = page ? { page } : {};
  for (const raw of text.trim().split(/\n\s*\n/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const anchor = `${prefix}-b${blocks.length}`;
    const lines = chunk.split("\n");
    const heading = HEADING.exec(chunk);
    if (heading) {
      blocks.push({ anchor, kind: "heading", level: (heading[1] as string).length, text: heading[2] as string, ...at });
    } else if (chunk.startsWith("|")) {
      blocks.push({ anchor, kind: "table", text: chunk, ...at });
    } else if (lines.every((l) => LIST.test(l))) {
      lines.forEach((line, i) => {
        blocks.push({ anchor: `${anchor}-${i}`, kind: "list_item", text: LIST.exec(line)?.[2] as string, ...at });
      });
    } else {
      blocks.push({ anchor, kind: "paragraph", text: chunk, ...at });
    }
  }
  return blocks;
}
