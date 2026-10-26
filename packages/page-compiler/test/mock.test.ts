import { describe, expect, test } from "vitest";
import { mockNameTopics } from "../src/mock.ts";
import { NAME_TASK, type NameOutput, type TopicInput } from "../src/protocol.ts";

function titles(...topics: Omit<TopicInput, "ref" | "statements">[]): string[] {
  const input = { language: "zh", topics: topics.map((t, i) => ({ ref: `t${i + 1}`, statements: [], ...t })) };
  const answer = mockNameTopics([{ role: "user", content: `<input>${JSON.stringify(input)}</input>` }], {
    task: NAME_TASK,
  });
  return (JSON.parse(answer as string) as NameOutput).topics.map((t) => t.title);
}

const heading = (text: string, sections = 1) => ({ text, sections });

describe("the naming mock", () => {
  test("a topic takes the heading its sections share, else what its headings have in common", () => {
    expect(
      titles(
        { level: 2, headings: [heading("第三章 住宿费", 3), heading("交通费")], documents: ["差旅费管理办法"] },
        { level: 2, headings: [heading("住宿费"), heading("一线城市住宿标准")], documents: ["办法", "通知"] },
        { level: 2, headings: [heading("附件"), heading("其他")], documents: ["新人入职指南（2026 版）"] },
      ),
    ).toEqual(["住宿费", "住宿", "新人入职指南"]);
  });

  test("an area or a split topic is named after what the titles below it share, never like one of them", () => {
    expect(
      titles(
        { level: 1, headings: [], documents: ["差旅费管理办法"], topics: ["差旅住宿", "差旅补助"] },
        { level: 1, headings: [], documents: ["费用报销管理规定"], topics: ["报销", "报销时限"] },
        {
          level: 2,
          headings: [heading("总则", 4)],
          documents: ["采购管理办法"],
          topics: ["管理办法", "采购审批管理办法"],
        },
        { level: 1, headings: [], documents: ["人事部办事指南"], topics: ["比价", "考勤"] },
      ),
    ).toEqual(["差旅", "报销相关", "管理办法相关", "人事部办事指南"]);
  });
});
