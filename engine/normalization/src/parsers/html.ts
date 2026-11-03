/**
 * HTML: headings, paragraphs, lists, tables, quotes and preformatted text. Loose text in a
 * container becomes a paragraph. Scripts, styles and the head are skipped. Outside
 * preformatted text, white space collapses as a browser collapses it: a line break in the
 * source is a space (none between Chinese or Japanese characters), and only <br> and block
 * elements break lines.
 */

import type { DocBlock, FileMeta, ParseResult, Parser } from "@inspiration/contracts";
import { type ChildNode, type Element, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";
import { decode, producer } from "./parser.ts";

const SKIP = new Set(["script", "style", "head", "noscript", "template", "svg", "nav"]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const TEXT_BLOCKS: Record<string, DocBlock["kind"]> = {
  p: "paragraph",
  blockquote: "quote",
  pre: "code",
  figcaption: "caption",
  caption: "caption",
  dt: "paragraph",
  dd: "paragraph",
};
const CONTAINERS = new Set([
  "html",
  "body",
  "main",
  "article",
  "section",
  "div",
  "header",
  "footer",
  "aside",
  "figure",
  "dl",
  "form",
  "fieldset",
]);
const BREAKS = new Set(["br", "p", "div", "li", "tr"]);

/** A line break in the source text, until the text around it is joined. */
const SEGMENT = "\uE000";
const WIDE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\u3000-\u303f\uff00-\uffef]/u;

function joined(nodes: readonly ChildNode[], pre: boolean): string {
  let out = "";
  for (const n of nodes) {
    if (isText(n)) out += pre ? n.data : n.data.replace(/[ \t\r\f]*\n[ \t\n\r\f]*/g, SEGMENT);
    else if (isTag(n) && !SKIP.has(n.name)) {
      if (n.name === "br") out += "\n";
      else if (n.name === "img") out += n.attribs.alt ?? "";
      else {
        out += joined(n.children, pre || n.name === "pre");
        if (BREAKS.has(n.name)) out += "\n";
      }
    }
  }
  return out;
}

function textOf(nodes: readonly ChildNode[], pre = false): string {
  const out = joined(nodes, pre);
  if (pre) return out;
  // As CSS Text 3 has it, a line break between two East Asian wide characters goes away and
  // any other is a space, so a Chinese sentence wrapped in the source reads as one.
  const spaced = out.replace(/[ \t\r\f]*\uE000[ \t\r\f\uE000]*/gu, (m, at: number, all: string) =>
    WIDE.test(all.charAt(at - 1)) && WIDE.test(all.charAt(at + m.length)) ? "" : " ",
  );
  return spaced.replace(/[ \t\r\f]+/g, " ").replace(/ ?\n ?/g, "\n");
}

export function parseHtml(html: string): DocBlock[] {
  const doc = parseDocument(html, { decodeEntities: true });
  let counter = 0;
  const anchor = (el?: Element) => (el?.attribs.id ? `#${el.attribs.id}` : `n${counter++}`);

  const list = (el: Element, depth: number): DocBlock[] =>
    el.children.filter(isTag).flatMap((li) => {
      if (li.name !== "li") return [];
      const nested = li.children.filter((c) => isTag(c) && (c.name === "ul" || c.name === "ol")) as Element[];
      const own = li.children.filter((c) => !nested.includes(c as Element));
      const block: DocBlock = { anchor: anchor(li), kind: "list_item", text: textOf(own).trim(), level: depth };
      if (el.name === "ol") block.attrs = { ordered: true };
      const children = nested.flatMap((n) => list(n, depth + 1));
      if (children.length) block.children = children;
      return [block];
    });

  const table = (el: Element): DocBlock => {
    const rows: Element[] = [];
    const collect = (e: Element) => {
      for (const c of e.children.filter(isTag)) {
        if (c.name === "tr") rows.push(c);
        else if (c.name === "thead" || c.name === "tbody" || c.name === "tfoot") collect(c);
      }
    };
    collect(el);
    const header = rows[0]?.children.some((c) => isTag(c) && c.name === "th") ?? false;
    return {
      anchor: anchor(el),
      kind: "table",
      ...(header && { attrs: { header_rows: 1 } }),
      children: rows.map((tr, r) => ({
        anchor: anchor(tr),
        kind: "table_row",
        cell: { row: r },
        children: tr.children
          .filter((c): c is Element => isTag(c) && (c.name === "td" || c.name === "th"))
          .map((td, c) => ({
            anchor: anchor(td),
            kind: "table_cell",
            text: textOf(td.children).trim(),
            cell: { row: r, col: c },
          })),
      })),
    };
  };

  const blocks = (nodes: readonly ChildNode[]): DocBlock[] => {
    const out: DocBlock[] = [];
    let loose: ChildNode[] = [];
    const flush = () => {
      const text = textOf(loose).trim();
      if (text) out.push({ anchor: anchor(), kind: "paragraph", text });
      loose = [];
    };
    for (const n of nodes) {
      if (!isTag(n)) {
        if (isText(n)) loose.push(n);
        continue;
      }
      if (SKIP.has(n.name)) continue;
      const level = HEADINGS[n.name];
      const kind = TEXT_BLOCKS[n.name];
      if (level !== undefined) {
        flush();
        out.push({ anchor: anchor(n), kind: "heading", level, text: textOf(n.children).trim() });
      } else if (kind) {
        flush();
        const text = textOf(n.children, n.name === "pre").trim();
        if (text) out.push({ anchor: anchor(n), kind, text });
      } else if (n.name === "ul" || n.name === "ol") {
        flush();
        out.push(...list(n, 0));
      } else if (n.name === "table") {
        flush();
        out.push(table(n));
      } else if (n.name === "img" && !loose.length) {
        out.push({ anchor: anchor(n), kind: "image", text: n.attribs.alt ?? "", attrs: { src: n.attribs.src } });
      } else if (CONTAINERS.has(n.name)) {
        flush();
        out.push(...blocks(n.children));
      } else if (n.name === "hr") {
        flush();
      } else loose.push(n);
    }
    flush();
    return out;
  };

  return blocks(doc.children);
}

export const htmlParser: Parser = {
  name: "html",
  version: "2",
  accepts: (meta: FileMeta) => (meta.mime_type === "text/html" || /\.html?$/i.test(meta.filename ?? "") ? 1 : 0),
  async parse(file, _meta, _hints, ctx): Promise<ParseResult> {
    return { blocks: parseHtml(decode(await ctx.blobs.get(file))), parser: producer(this) };
  },
};
