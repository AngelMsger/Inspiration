import { slotOf } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { effectiveFrom, extractWindow, parseVocabulary, readValue, VocabularyError } from "../src/index.ts";
import { VOCABULARY } from "./fixtures.ts";

const [hotel, deadline] = VOCABULARY.predicates as [
  (typeof VOCABULARY.predicates)[number],
  (typeof VOCABULARY.predicates)[number],
];

describe("the extraction mock", () => {
  test("values are the number before a unit word, or a known enum value", () => {
    expect(readValue("工作满 1 年不满 10 年的，出差结束后 30 日内报销。", deadline)).toMatchObject({ number: 30 });
    expect(readValue("每晚 600 元。", hotel)).toEqual({
      kind: "money",
      number: 600,
      unit: "CNY/night",
      currency: "CNY",
      normalized: "600 CNY/night",
    });
    expect(readValue("住宿费凭发票报销。", hotel)).toBeUndefined();
    // A calendar day is when, not how long.
    expect(readValue("自 2026 年 7 月 1 日起，出差结束后 60 天内报销。", deadline)).toMatchObject({ number: 60 });
    expect(readValue("自 2026 年 7 月 1 日起，", deadline)).toBeUndefined();
  });

  test("a passage's effective day is read in both written forms", () => {
    expect(effectiveFrom("自 2026 年 10 月 1 日起，住宿限额调整为每晚 650 元。")).toBe("2026-10-01");
    expect(effectiveFrom("2027-01-15 起执行。")).toBe("2027-01-15");
    expect(effectiveFrom("2026 年 9 月 28 日")).toBeUndefined();
  });

  test("a change decided without a day takes the document's date", () => {
    const window = (date?: string) =>
      extractWindow({
        document: { title: "经营会纪要", ...(date && { date }) },
        vocabulary: VOCABULARY.predicates,
        blocks: [
          {
            kind: "list_item",
            heading_path: ["决议"],
            spans: [{ ref: "s1", text: "一线城市住宿限额调整为每晚 650 元。" }],
          },
        ],
      }).map((c) => c.valid_from);
    expect(window("2026-09-26")).toEqual(["2026-09-26"]);
    expect(window()).toEqual([undefined]);
  });

  test("passages that state nothing checkable are skipped; the longest alias picks the qualifier", () => {
    const claims = extractWindow({
      document: { title: "差旅" },
      vocabulary: VOCABULARY.predicates,
      blocks: [
        {
          kind: "paragraph",
          heading_path: [],
          spans: [
            { ref: "s1", text: "新一线城市住宿限额为每晚 450 元。" },
            { ref: "s2", text: "住宿要提前订吗？" },
            { ref: "s3", text: "谢谢大家。" },
            { ref: "s4", text: "研发部 2027 年计划招聘 40 人。" },
          ],
        },
      ],
    });
    expect(claims.map((c) => [c.evidence[0]?.span, c.claim_type, slotOf(c)])).toEqual([
      ["s1", "rule", "hotel_cap_per_night|新一线城市"],
      ["s4", "plan", undefined],
    ]);
    expect(claims[1]).toMatchObject({ subject: "差旅", knowledge_class: "general", confidence: 0.7 });
  });

  test("a catalogue is validated", () => {
    expect(() =>
      parseVocabulary({ predicates: [{ predicate: "Hotel Cap", label: "x", aliases: [], value: {} }] }),
    ).toThrow(VocabularyError);
  });
});
