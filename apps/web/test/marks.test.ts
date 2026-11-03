// The Annotated view's marks: which passage each statement rests on, what holds instead of an
// outdated value, and which words light up in which tone.

import type { Citation, DocumentView, SearchHit, SourceBlock } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { highlight, marksOf, passages, weakest } from "../src/marks.ts";

const VERSION = "sv_01POLICY";

function block(id: string, ordinal: number, kind: SourceBlock["kind"], text: string, more: Partial<SourceBlock> = {}) {
  return { id, ordinal, kind, text, span_ids: [`spn_${id}`], source_version_id: VERSION, ...more } as SourceBlock;
}

function cite(span: string, quote: string, more: Partial<Citation> = {}): Citation {
  return { span_id: span, source_version_id: VERSION, source_title: "Travel policy", quote, ...more } as Citation;
}

function statement(id: string, citations: Citation[], more: Partial<SearchHit> = {}): SearchHit {
  return { unit_id: id, kind: "claim", title: "Travel policy", snippet: id, score: 0, citations, ...more } as SearchHit;
}

const blocks = [
  block("title", 0, "heading", "Travel policy", { level: 1 }),
  block("rule", 1, "paragraph", "Article 7. Hotels are paid up to the cap for the city."),
  block("table", 2, "table", "City\tCap\nTier 1\t600\nOther\t350", { span_ids: [], attrs: { header_rows: 1 } }),
  block("head", 3, "table_row", "City\tCap", { parent_id: "table", span_ids: [] }),
  block("tier1", 4, "table_row", "Tier 1\t600", { parent_id: "table" }),
  block("other", 5, "table_row", "Other\t350", { parent_id: "table" }),
];

const notice = statement(
  "clm_notice",
  [cite("spn_notice", "From October 1 the Tier 1 cap is 650.", { source_version_id: "sv_01NOTICE" })],
  { standing: "holds", title: "Notice" },
);
const view = {
  version: { id: VERSION },
  blocks,
  annotations: {
    source_version_id: VERSION,
    statements: [
      statement("clm_rule", [cite("spn_rule", "paid up to the cap")]),
      statement(
        "clm_600",
        [cite("spn_tier1", "600", { locator: { block_anchor: "L4", kind: "table_cell", cell: { row: 1, col: 1 } } })],
        {
          standing: "outdated",
          held_unit_id: "clm_notice",
        },
      ),
      statement("clm_350", [cite("spn_other", "350")], { standing: "holds" }),
      // Cites another document only: no mark here.
      statement("clm_elsewhere", [cite("spn_rule", "Hotels", { source_version_id: "sv_01OTHER" })]),
    ],
    held: [notice],
  },
} as unknown as DocumentView;

describe("marks", () => {
  test("a table's rows sit inside the table", () => {
    const list = passages(blocks);
    expect(list.map((p) => p.block.id)).toEqual(["title", "rule", "table"]);
    expect(list[2]?.rows.map((r) => r.id)).toEqual(["head", "tier1", "other"]);
  });

  test("each statement marks the passage holding the spans it cites in this version", () => {
    const marks = marksOf(view);
    expect([...marks.keys()].sort()).toEqual(["rule", "table"]);
    expect(marks.get("rule")?.map((m) => m.statement.unit_id)).toEqual(["clm_rule"]);
    const table = marks.get("table") ?? [];
    expect(table.map((m) => m.statement.unit_id)).toEqual(["clm_600", "clm_350"]);
    expect(table[0]?.held?.unit_id).toBe("clm_notice");
    expect(table[0]?.quotes).toEqual([{ text: "600", tone: "outdated", row: "tier1", cell: { row: 1, col: 1 } }]);
    expect(table[1]?.quotes).toEqual([{ text: "350", tone: "marked", row: "other" }]);
  });

  test("the passage reads as its weakest value", () => {
    expect(weakest(["marked", "outdated"])).toBe("outdated");
    expect(weakest(["outdated", "disputed", "marked"])).toBe("disputed");
    expect(weakest([])).toBeUndefined();
  });

  test("highlights each quote once, the weakest first where two overlap", () => {
    expect(
      highlight("cap 600, then 600 again", [
        { text: "600", tone: "marked" },
        { text: "cap 600", tone: "outdated" },
        { text: "600", tone: "marked" },
      ]),
    ).toEqual([
      { text: "cap 600", tone: "outdated" },
      { text: ", then " },
      { text: "600", tone: "marked" },
      { text: " again" },
    ]);
    expect(highlight("no quotes", [{ text: "", tone: "marked" }])).toEqual([{ text: "no quotes" }]);
  });
});
