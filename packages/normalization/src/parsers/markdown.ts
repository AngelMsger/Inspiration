/** Markdown (CommonMark with GitHub tables and task lists), front matter skipped. */

import type { DocBlock, FileMeta, ParseResult, Parser } from "@inspiration/contracts";
import type { List, ListItem, Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString as textOf } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { decode, producer } from "./shared.ts";

const MATTER = ["yaml", "toml"] as const;

export function parseMarkdown(text: string): DocBlock[] {
  const root: Root = fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...MATTER])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...MATTER])],
  });
  return root.children.flatMap((n) => convert(n, 0));
}

const anchor = (n: Nodes, suffix = "") => `L${n.position?.start.line ?? 0}${suffix}`;
const plain = (n: Nodes) => textOf(n, { includeHtml: false }).trim();

function item(li: ListItem, list: List, depth: number): DocBlock {
  const own = li.children.filter((c) => c.type === "paragraph").map(plain);
  const block: DocBlock = { anchor: anchor(li), kind: "list_item", text: own.join("\n"), level: depth };
  const attrs: Record<string, unknown> = {};
  if (list.ordered) attrs.ordered = true;
  if (typeof li.checked === "boolean") attrs.checked = li.checked;
  if (Object.keys(attrs).length) block.attrs = attrs;
  const children = li.children.filter((c) => c.type !== "paragraph").flatMap((c) => convert(c, depth + 1));
  if (children.length) block.children = children;
  return block;
}

function convert(n: RootContent, depth: number): DocBlock[] {
  switch (n.type) {
    case "heading":
      return [{ anchor: anchor(n), kind: "heading", level: n.depth, text: plain(n) }];
    case "paragraph": {
      const only = n.children.length === 1 ? n.children[0] : undefined;
      if (only?.type === "image") {
        return [{ anchor: anchor(n), kind: "image", text: only.alt ?? "", attrs: { src: only.url } }];
      }
      return [{ anchor: anchor(n), kind: "paragraph", text: plain(n) }];
    }
    case "list":
      return n.children.map((li) => item(li, n, depth));
    case "code":
      return [{ anchor: anchor(n), kind: "code", text: n.value, ...(n.lang && { attrs: { lang: n.lang } }) }];
    case "blockquote":
      return [{ anchor: anchor(n), kind: "quote", text: n.children.map(plain).filter(Boolean).join("\n") }];
    case "table":
      return [
        {
          anchor: anchor(n),
          kind: "table",
          attrs: { header_rows: 1 },
          children: n.children.map((row, r) => ({
            anchor: anchor(row),
            kind: "table_row",
            cell: { row: r },
            children: row.children.map((cell, c) => ({
              anchor: anchor(cell, `:c${c}`),
              kind: "table_cell",
              text: plain(cell),
              cell: { row: r, col: c },
            })),
          })),
        },
      ];
    case "html": {
      const text = n.value.replace(/<[^>]*>/g, " ").trim();
      return text ? [{ anchor: anchor(n), kind: "other", text }] : [];
    }
    case "footnoteDefinition":
      return [{ anchor: anchor(n), kind: "paragraph", text: plain(n), attrs: { footnote: n.identifier } }];
    default:
      // Front matter, thematic breaks and link definitions carry no content of their own.
      return [];
  }
}

export const markdownParser: Parser = {
  name: "markdown",
  version: "1",
  accepts: (meta: FileMeta) =>
    meta.mime_type === "text/markdown" || /\.(md|markdown)$/i.test(meta.filename ?? "") ? 1 : 0,
  async parse(file, _meta, _hints, ctx): Promise<ParseResult> {
    return { blocks: parseMarkdown(decode(await ctx.blobs.get(file))), parser: producer(this) };
  },
};
