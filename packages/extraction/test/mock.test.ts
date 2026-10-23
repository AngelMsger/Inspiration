import { describe, expect, test } from "vitest";
import { extractWindow, parseVocabulary, readValue, slotOf, VocabularyError } from "../src/index.ts";
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
