import type { SourceVersion } from "@inspiration/contracts";
import { testData } from "@inspiration/testkit";
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
const DOC = { sourceId: "src_01JC0000000000000000000001", externalId: "travel-policy.md" };

function blocksOf(markdown: string, version = VERSION) {
  const drafts = flatten(parseMarkdown(markdown));
  return build(drafts, draftIds(drafts, DOC, false), version);
}

/** Cases in one language, from test/data/<tag>.yaml. */
interface Cases {
  passages: { text: string; passages: string[] }[];
  /** An over-long sentence: two runs of characters and the comma it is cut at. */
  cut: { first: string; comma: string; second: string; stop: string };
  /** Thirty articles ({n} is the number), a change of formatting, a light edit and an unrelated text. */
  fingerprint: { article: string; reformat: [string, string]; edit: [string, string]; other: string };
  /** A paragraph whose sentence the HTML source wraps over lines, and the text it reads as. */
  wrapped: { html: string; text: string };
}

const LANGUAGES = ["en", "ja", "zh"].map((tag) => ({ tag, ...testData<Cases>(import.meta.url, `${tag}.yaml`) }));

describe.each(LANGUAGES)("passages in $tag", ({ passages: cases, cut, wrapped }) => {
  test("sentences, clauses and closing quotes; short fragments join the next one; offsets into the text", () => {
    for (const { text, passages: expected } of cases) {
      const found = passages(text);
      expect(found.map((p) => p.text)).toEqual(expected);
      for (const p of found) expect(text.slice(p.start, p.end)).toBe(p.text);
    }
  });

  test("an over-long sentence is cut at a comma", () => {
    const text = `${cut.first.repeat(300)}${cut.comma}${cut.second.repeat(300)}${cut.stop}`;
    const found = passages(text);
    expect(found.length).toBe(2);
    expect(found.every((p) => p.text.length <= MAX_PASSAGE)).toBe(true);
    expect(found.map((p) => p.text).join("")).toBe(text);
  });

  test("a sentence the HTML source wraps over lines reads as one", () => {
    expect(parseHtml(wrapped.html).map((b) => b.text)).toEqual([wrapped.text]);
  });
});

describe("parsers", () => {
  test("Markdown: outline, nested lists, tables, code, images; front matter skipped", () => {
    const blocks = parseMarkdown(
      "---\ntitle: Travel\n---\n# Policy\n\nArticle 1 Text.\n\n- Tier-1 cities\n  - Breakfast included\n1. First step\n\n| City | Rate |\n| --- | --- |\n| Beijing | 600 |\n\n```sql\nselect 1;\n```\n\n![Flow chart](a.png)\n",
    );
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "Policy"],
      ["paragraph", "Article 1 Text."],
      ["list_item", "Tier-1 cities"],
      ["list_item", "First step"],
      ["table", undefined],
      ["code", "select 1;"],
      ["image", "Flow chart"],
    ]);
    expect(blocks[2]?.children?.[0]).toMatchObject({ kind: "list_item", text: "Breakfast included", level: 1 });
    expect(blocks[3]?.attrs).toEqual({ ordered: true });
    expect(blocks[4]?.children?.[1]?.children?.map((c) => c.text)).toEqual(["Beijing", "600"]);
    expect(blocks[0]?.anchor).toBe("L4");
  });

  test("HTML: headings, loose text, nested lists, header rows; scripts skipped", () => {
    const blocks = parseHtml(
      "<html><head><title>x</title><script>alert(1)</script></head><body><h2 id='a'>Title</h2><div>Loose <b>text</b><p>Paragraph</p></div><ul><li>First<ul><li>Second</li></ul></li></ul><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>",
    );
    expect(blocks.map((b) => [b.kind, b.text ?? ""])).toEqual([
      ["heading", "Title"],
      ["paragraph", "Loose text"],
      ["paragraph", "Paragraph"],
      ["list_item", "First"],
      ["table", ""],
    ]);
    expect(blocks[0]).toMatchObject({ anchor: "#a", level: 2 });
    expect(blocks[3]?.children?.[0]?.text).toBe("Second");
    expect(blocks[4]?.attrs).toEqual({ header_rows: 1 });
  });

  test("HTML: a line break in the source is a space, except in preformatted text and at <br>", () => {
    const blocks = parseHtml(
      "<p>Once a container has run for 10 minutes without any\nproblems, the <b>kubelet</b>\n  resets  the timer.</p><p>One<br>Two</p><pre>a\n  b</pre>",
    );
    expect(blocks.map((b) => b.text)).toEqual([
      "Once a container has run for 10 minutes without any problems, the kubelet resets the timer.",
      "One\nTwo",
      "a\n  b",
    ]);
  });

  test("CSV and plain text", () => {
    const [table] = parseCsv('﻿Department,Limit\nFinance,"500,tax included"\n');
    expect(table?.children?.map((r) => r.children?.map((c) => c.text))).toEqual([
      ["Department", "Limit"],
      ["Finance", "500,tax included"],
    ]);
    expect(parseText("First paragraph\ncontinued\n\n\nSecond paragraph")).toEqual([
      { anchor: "L1", kind: "paragraph", text: "First paragraph\ncontinued" },
      { anchor: "L5", kind: "paragraph", text: "Second paragraph" },
    ]);
  });
});

describe("blocks", () => {
  test("heading paths, parents, and table cells as the rows' spans", () => {
    const { blocks, spans } = blocksOf(
      "# Policy\n\n## Chapter 1\n\n- First\n  - Second\n\n| City | Rate |\n| --- | --- |\n| Beijing | 600 |\n",
    );
    expect(blocks.map((b) => [b.kind, b.heading_path ?? []])).toEqual([
      ["heading", []],
      ["heading", ["Policy"]],
      ["list_item", ["Policy", "Chapter 1"]],
      ["list_item", ["Policy", "Chapter 1"]],
      ["table", ["Policy", "Chapter 1"]],
      ["table_row", ["Policy", "Chapter 1"]],
      ["table_row", ["Policy", "Chapter 1"]],
    ]);
    expect(blocks[3]?.parent_id).toBe(blocks[2]?.id);
    expect(blocks[5]?.parent_id).toBe(blocks[4]?.id);
    expect(blocks[4]?.text).toBe("City\tRate\nBeijing\t600");
    expect(blocks[0]?.span_ids).toEqual([]);
    const cells = spans.filter((s) => s.locator.kind === "table_cell");
    expect(cells.map((s) => [s.text, s.locator.cell])).toEqual([
      ["City", { row: 0, col: 0 }],
      ["Rate", { row: 0, col: 1 }],
      ["Beijing", { row: 1, col: 0 }],
      ["600", { row: 1, col: 1 }],
    ]);
    const row = blocks[6];
    const cell = cells[3];
    expect(row?.text.slice(cell?.locator.char_start, cell?.locator.char_end)).toBe("600");
    expect(spans.map((s) => s.ordinal)).toEqual(spans.map((_, i) => i));
  });

  test("the same text under another heading is another block; repeats are numbered", () => {
    const { blocks } = blocksOf("# First\n\nAs above.\n\nAs above.\n\n# Second\n\nAs above.\n");
    const ids = blocks.filter((b) => b.kind === "paragraph").map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(blocksOf("# First\n\nAs above.\n\nAs above.\n\n# Second\n\nAs above.\n").blocks.map((b) => b.id)).toEqual(
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
      "# Policy\n\nArticle 1 Hotels cost at most 500 yuan a night. Article 2 Meals are extra.\n\nArticle 3 This policy takes effect when published.\n",
      "# Policy\n\nArticle 1 Hotels cost at most 600 yuan a night. Article 2 Meals are extra.\n\nArticle 3 This policy takes effect when published.\n",
    );
    expect(next.blocks.map((b) => b.id)).toEqual(old.blocks.map((b) => b.id));
    expect(next.blocks[1]?.text_hash).not.toBe(old.blocks[1]?.text_hash);
    const [changed, kept] = next.blocks[1]?.span_ids ?? [];
    expect(changed).not.toBe(old.blocks[1]?.span_ids[0]);
    expect(kept).toBe(old.blocks[1]?.span_ids[1]);
  });

  test("an inserted paragraph is new and moves nothing else", () => {
    const { old, next } = aligned(
      "# Policy\n\nClause A.\n\nClause B.\n",
      "# Policy\n\nClause A.\n\nA new clause C, added later.\n\nClause B.\n",
    );
    const before = new Set(old.blocks.map((b) => b.id));
    expect(next.blocks.map((b) => before.has(b.id))).toEqual([true, true, false, true]);
  });

  test("a rewritten paragraph is a new block", () => {
    const { old, next } = aligned(
      "# Policy\n\nHotels cost at most five hundred yuan a night.\n",
      "# Policy\n\nTrips are requested in the system in advance.\n",
    );
    expect(next.blocks[1]?.id).not.toBe(old.blocks[1]?.id);
    expect(
      similarity("Hotels cost at most five hundred yuan a night.", "Trips are requested in the system in advance."),
    ).toBeLessThan(0.5);
  });
});

describe.each(LANGUAGES)("fingerprints in $tag", ({ fingerprint: cases }) => {
  const policy = Array.from({ length: 30 }, (_, i) => cases.article.replace("{n}", String(i + 1))).join("\n");

  test("a lightly edited copy is near; formatting does not count; another text is far", () => {
    const base = fingerprint(policy);
    const reformatted = policy.replaceAll(...cases.reformat).replaceAll("\n", "\n\n");
    expect(fingerprint(reformatted).text_hash).toBe(base.text_hash);
    const edited = fingerprint(policy.replace(...cases.edit));
    expect(edited.text_hash).not.toBe(base.text_hash);
    expect(hamming(base.simhash, edited.simhash)).toBeLessThanOrEqual(NEAR);
    // Unrelated texts differ in 32 bits give or take 4: one pair in eight lies within 27, one in 3,000 within 18.
    const other = fingerprint(cases.other.repeat(10));
    expect(hamming(base.simhash, other.simhash)).toBeGreaterThan(NEAR * 2);
  });
});
