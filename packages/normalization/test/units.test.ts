import type { SourceVersion } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import {
  align,
  build,
  draftIds,
  fingerprint,
  flatten,
  hamming,
  MAX_PASSAGE,
  NEAR,
  parseCsv,
  parseHtml,
  parseMarkdown,
  parseText,
  passages,
  similarity,
} from "../src/index.ts";

const VERSION = { id: "sv_01JC0000000000000000000001", tenant_id: "ten_01JC0000000000000000000001" } as SourceVersion;
const DOC = { sourceId: "src_01JC0000000000000000000001", externalId: "差旅费管理办法.md" };

function blocksOf(markdown: string, version = VERSION) {
  const drafts = flatten(parseMarkdown(markdown));
  return build(drafts, draftIds(drafts, DOC, false), version);
}

describe("passages", () => {
  test("Chinese sentences and clauses, English sentences, offsets into the text", () => {
    const text =
      "第一条 为规范差旅费管理，制定本办法。第二条 适用于：（一）国内出差；（二）境外出差。\nHotels cost 600 RMB, e.g. in Beijing. Meals are extra.";
    const found = passages(text);
    expect(found.map((p) => p.text)).toEqual([
      "第一条 为规范差旅费管理，制定本办法。",
      "第二条 适用于：（一）国内出差；",
      "（二）境外出差。",
      "Hotels cost 600 RMB, e.g. in Beijing.",
      "Meals are extra.",
    ]);
    for (const p of found) expect(text.slice(p.start, p.end)).toBe(p.text);
  });

  test("closing quotes stay with their sentence; short fragments join the next one", () => {
    expect(passages("他说：“同意。”然后离开。").map((p) => p.text)).toEqual(["他说：“同意。”", "然后离开。"]);
    expect(passages("注：\n报销需附发票。").map((p) => p.text)).toEqual(["注：\n报销需附发票。"]);
  });

  test("an over-long sentence is cut at a comma", () => {
    const text = `${"甲".repeat(300)}，${"乙".repeat(300)}。`;
    const found = passages(text);
    expect(found.length).toBe(2);
    expect(found.every((p) => p.text.length <= MAX_PASSAGE)).toBe(true);
    expect(found.map((p) => p.text).join("")).toBe(text);
  });
});

describe("parsers", () => {
  test("Markdown: outline, nested lists, tables, code, images; front matter skipped", () => {
    const blocks = parseMarkdown(
      "---\ntitle: 差旅\n---\n# 办法\n\n第一条 正文。\n\n- 一线城市\n  - 含早餐\n1. 第一步\n\n| 城市 | 标准 |\n| --- | --- |\n| 北京 | 600 |\n\n```sql\nselect 1;\n```\n\n![流程图](a.png)\n",
    );
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "办法"],
      ["paragraph", "第一条 正文。"],
      ["list_item", "一线城市"],
      ["list_item", "第一步"],
      ["table", undefined],
      ["code", "select 1;"],
      ["image", "流程图"],
    ]);
    expect(blocks[2]?.children?.[0]).toMatchObject({ kind: "list_item", text: "含早餐", level: 1 });
    expect(blocks[3]?.attrs).toEqual({ ordered: true });
    expect(blocks[4]?.children?.[1]?.children?.map((c) => c.text)).toEqual(["北京", "600"]);
    expect(blocks[0]?.anchor).toBe("L4");
  });

  test("HTML: headings, loose text, nested lists, header rows; scripts skipped", () => {
    const blocks = parseHtml(
      "<html><head><title>x</title><script>alert(1)</script></head><body><h2 id='a'>标题</h2><div>松散 <b>文字</b><p>段落</p></div><ul><li>甲<ul><li>乙</li></ul></li></ul><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>",
    );
    expect(blocks.map((b) => [b.kind, b.text ?? ""])).toEqual([
      ["heading", "标题"],
      ["paragraph", "松散 文字"],
      ["paragraph", "段落"],
      ["list_item", "甲"],
      ["table", ""],
    ]);
    expect(blocks[0]).toMatchObject({ anchor: "#a", level: 2 });
    expect(blocks[3]?.children?.[0]?.text).toBe("乙");
    expect(blocks[4]?.attrs).toEqual({ header_rows: 1 });
  });

  test("CSV and plain text", () => {
    const [table] = parseCsv('﻿部门,限额\n财务部,"500,含税"\n');
    expect(table?.children?.map((r) => r.children?.map((c) => c.text))).toEqual([
      ["部门", "限额"],
      ["财务部", "500,含税"],
    ]);
    expect(parseText("第一段\n续行\n\n\n第二段")).toEqual([
      { anchor: "L1", kind: "paragraph", text: "第一段\n续行" },
      { anchor: "L5", kind: "paragraph", text: "第二段" },
    ]);
  });
});

describe("blocks", () => {
  test("heading paths, parents, and table cells as the rows' spans", () => {
    const { blocks, spans } = blocksOf(
      "# 办法\n\n## 第一章\n\n- 甲\n  - 乙\n\n| 城市 | 标准 |\n| --- | --- |\n| 北京 | 600 |\n",
    );
    expect(blocks.map((b) => [b.kind, b.heading_path ?? []])).toEqual([
      ["heading", []],
      ["heading", ["办法"]],
      ["list_item", ["办法", "第一章"]],
      ["list_item", ["办法", "第一章"]],
      ["table", ["办法", "第一章"]],
      ["table_row", ["办法", "第一章"]],
      ["table_row", ["办法", "第一章"]],
    ]);
    expect(blocks[3]?.parent_id).toBe(blocks[2]?.id);
    expect(blocks[5]?.parent_id).toBe(blocks[4]?.id);
    expect(blocks[4]?.text).toBe("城市\t标准\n北京\t600");
    expect(blocks[0]?.span_ids).toEqual([]);
    const cells = spans.filter((s) => s.locator.kind === "table_cell");
    expect(cells.map((s) => [s.text, s.locator.cell])).toEqual([
      ["城市", { row: 0, col: 0 }],
      ["标准", { row: 0, col: 1 }],
      ["北京", { row: 1, col: 0 }],
      ["600", { row: 1, col: 1 }],
    ]);
    const row = blocks[6];
    const cell = cells[3];
    expect(row?.text.slice(cell?.locator.char_start, cell?.locator.char_end)).toBe("600");
    expect(spans.map((s) => s.ordinal)).toEqual(spans.map((_, i) => i));
  });

  test("the same text under another heading is another block; repeats are numbered", () => {
    const { blocks } = blocksOf("# 甲\n\n同上。\n\n同上。\n\n# 乙\n\n同上。\n");
    const ids = blocks.filter((b) => b.kind === "paragraph").map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(blocksOf("# 甲\n\n同上。\n\n同上。\n\n# 乙\n\n同上。\n").blocks.map((b) => b.id)).toEqual(
      blocks.map((b) => b.id),
    );
  });
});

describe("alignment", () => {
  const v2 = { ...VERSION, id: "sv_01JC0000000000000000000002" } as SourceVersion;
  const aligned = (before: string, after: string) => {
    const old = blocksOf(before);
    const drafts = flatten(parseMarkdown(after));
    const first = draftIds(drafts, DOC, false);
    const ids = align(
      drafts.map((d, i) => ({ id: first[i] as string, kind: d.kind, text: d.text })),
      old.blocks,
    );
    return { old, next: build(drafts, ids, v2) };
  };

  test("an edited paragraph keeps its block ID and its unchanged sentences keep their span IDs", () => {
    const { old, next } = aligned(
      "# 办法\n\n第一条 住宿每晚 500 元。第二条 餐费另计。\n\n第三条 本办法自发布之日起施行。\n",
      "# 办法\n\n第一条 住宿每晚 600 元。第二条 餐费另计。\n\n第三条 本办法自发布之日起施行。\n",
    );
    expect(next.blocks.map((b) => b.id)).toEqual(old.blocks.map((b) => b.id));
    expect(next.blocks[1]?.text_hash).not.toBe(old.blocks[1]?.text_hash);
    const [changed, kept] = next.blocks[1]?.span_ids ?? [];
    expect(changed).not.toBe(old.blocks[1]?.span_ids[0]);
    expect(kept).toBe(old.blocks[1]?.span_ids[1]);
  });

  test("an inserted paragraph is new and moves nothing else", () => {
    const { old, next } = aligned(
      "# 办法\n\n甲条款。\n\n乙条款。\n",
      "# 办法\n\n甲条款。\n\n新增的丙条款内容。\n\n乙条款。\n",
    );
    const before = new Set(old.blocks.map((b) => b.id));
    expect(next.blocks.map((b) => before.has(b.id))).toEqual([true, true, false, true]);
  });

  test("a rewritten paragraph is a new block", () => {
    const { old, next } = aligned("# 办法\n\n住宿标准为每晚五百元。\n", "# 办法\n\n出差须提前在系统中申请。\n");
    expect(next.blocks[1]?.id).not.toBe(old.blocks[1]?.id);
    expect(similarity("住宿标准为每晚五百元。", "出差须提前在系统中申请。")).toBeLessThan(0.5);
  });
});

describe("fingerprints", () => {
  const policy = Array.from(
    { length: 30 },
    (_, i) => `第${i + 1}条 员工出差应当按照公司规定的标准报销住宿、交通和餐饮费用，超出部分由个人承担。`,
  ).join("\n");

  test("a lightly edited copy is near; formatting does not count; another text is far", () => {
    const base = fingerprint(policy);
    expect(fingerprint(policy.replaceAll("，", ", ").replaceAll("\n", "\n\n")).text_hash).toBe(base.text_hash);
    const edited = fingerprint(policy.replace("第3条", "第三条"));
    expect(edited.text_hash).not.toBe(base.text_hash);
    expect(hamming(base.simhash, edited.simhash)).toBeLessThanOrEqual(NEAR);
    const other = fingerprint("会议室预订须提前一天在行政系统提交申请，并注明参会人数和设备需求。".repeat(10));
    expect(hamming(base.simhash, other.simhash)).toBeGreaterThan(NEAR * 3);
  });
});
