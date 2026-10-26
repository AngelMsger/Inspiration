import { testData } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { mockNameTopics } from "../src/mock.ts";
import { NAME_TASK, type NameOutput, type TopicInput } from "../src/protocol.ts";

/** A topic as test/data/<tag>.yaml writes it: headings as [text, sections]. */
type Written = Omit<TopicInput, "ref" | "statements" | "headings"> & { headings: [string, number][] };

/** Cases in one language: topics and the titles the mock gives them. */
interface Cases {
  headings: { topics: Written[]; titles: string[] };
  areas: { topics: Written[]; titles: string[] };
}

const LANGUAGES = ["en", "ja", "zh"].map((tag) => ({ tag, ...testData<Cases>(import.meta.url, `${tag}.yaml`) }));

function titles(language: string, topics: readonly Written[]): string[] {
  const input = {
    language,
    topics: topics.map((t, i) => ({
      ref: `t${i + 1}`,
      statements: [],
      ...t,
      headings: t.headings.map(([text, sections]) => ({ text, sections })),
    })),
  };
  const answer = mockNameTopics([{ role: "user", content: `<input>${JSON.stringify(input)}</input>` }], {
    task: NAME_TASK,
  });
  return (JSON.parse(answer as string) as NameOutput).topics.map((t) => t.title);
}

describe.each(LANGUAGES)("the naming mock in $tag", ({ tag, headings, areas }) => {
  test("a topic takes the heading its sections share, else what its headings have in common", () => {
    expect(titles(tag, headings.topics)).toEqual(headings.titles);
  });

  test("an area or a split topic is named after what the titles below it share, never like one of them", () => {
    expect(titles(tag, areas.topics)).toEqual(areas.titles);
  });
});
