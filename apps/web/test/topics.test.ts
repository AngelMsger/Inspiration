// What the inbox and a topic page make of the engine's answers: values in the reader's words,
// the fact a todo is about, the sides of a conflict, and a topic's facts with what holds.

import { readFileSync } from "node:fs";
import type { Citation, InboxTodo, SearchHit, TopicView } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { factOf, noteText, sidesOf, valueText } from "../src/todos.ts";
import { pageOf } from "../src/topics.ts";
import type { Say } from "../src/words.ts";

// The English words, filled in as the page fills them (words.ts reads packs through the bundler).
const en = parse(readFileSync(new URL("../languages/en.yaml", import.meta.url), "utf8")) as Record<string, string>;
const say: Say = (key, params) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => String(params?.[name] ?? m));
const SLOT = "annual_leave_days|1 to 10 years";

function cite(span: string, version = "sv_POLICY"): Citation {
  return { span_id: span, source_version_id: version, source_title: "Leave policy", quote: span };
}

function statement(id: string, more: Partial<SearchHit> = {}): SearchHit {
  return {
    unit_id: id,
    kind: "claim",
    title: "Leave policy",
    snippet: id,
    score: 0,
    citations: [cite(`spn_${id}`)],
    ...more,
  } as SearchHit;
}

const conflict: InboxTodo = {
  todo: { id: "tdo_1", kind: "conflict", title: "Annual leave differs", slot_key: SLOT } as InboxTodo["todo"],
  fact_label: "Annual leave",
  statements: [statement("clm_five"), statement("clm_seven", { title: "Onboarding guide" })],
  choices: [
    { key: "choose:5 day", label: "Keep 5 day", value: "5 day", unit_id: "clm_five" },
    { key: "choose:7 day", label: "Choose 7 day", value: "7 day", unit_id: "clm_seven" },
    { key: "choose:9 day", label: "Choose 9 day", value: "9 day", unit_id: "clm_hidden" },
  ],
};

describe("an answer's notes", () => {
  test("name their values in the reader's words, else read as the engine wrote them", () => {
    const outdated = {
      kind: "outdated" as const,
      text: "Onboarding guide still state 7 day; that value was replaced, and 5 day holds.",
      unit_ids: ["clm_seven", "clm_five"],
    };
    expect(noteText(say, outdated)).toBe(outdated.text);
    expect(
      noteText(say, { ...outdated, held_value: "5 day", values: ["7 day"], documents: ["Onboarding guide"] }),
    ).toBe("5 days holds; 7 days in Onboarding guide was replaced.");
    expect(
      noteText(say, { kind: "conflict", text: "", unit_ids: [], held_value: "5 day", values: ["5 day", "7 day"] }),
    ).toBe("Sources differ: 5 days, 7 days. 5 days holds until someone decides.");
  });
});

describe("the inbox", () => {
  test("says values in the reader's words, and an unknown unit as it is", () => {
    expect(valueText(say, "5 day")).toBe("5 days");
    expect(valueText(say, "650 CNY/night")).toBe("¥650 a night");
    expect(valueText(say, "3 parsec")).toBe("3 parsec");
    expect(valueText(say, "Shenzhen")).toBe("Shenzhen");
    expect(valueText(say, undefined)).toBe("");
  });

  test("names the fact with its scope, else the topic, else the todo", () => {
    expect(factOf(say, conflict, undefined)).toBe("Annual leave (1 to 10 years)");
    const { fact_label: _, ...unlabelled } = conflict;
    const card = { batch_key: "b", kind: "review" as const, todos: [], topic: { title: "Leave" } as never };
    expect(factOf(say, unlabelled, card)).toBe("Leave (1 to 10 years)");
    expect(factOf(say, unlabelled, undefined)).toBe("Annual leave differs");
  });

  test("gives each side its statement, in the todo's order, when the member may read it", () => {
    const sides = sidesOf(conflict);
    expect(sides.map((s) => [s.choice.value, s.statement?.unit_id])).toEqual([
      ["5 day", "clm_five"],
      ["7 day", "clm_seven"],
      ["9 day", undefined],
    ]);
  });
});

describe("a topic page", () => {
  const view = (statements: SearchHit[], held: SearchHit[] = []): TopicView =>
    ({
      topic: { key: "t-leave", title: "Annual leave" },
      subtopics: [],
      statements,
      held,
      facts: [{ slot_key: SLOT, label: "Annual leave" }, { slot_key: "carry_over" }],
    }) as unknown as TopicView;

  test("shows what holds for each fact and what is written against it", () => {
    const page = pageOf(
      view([
        statement("clm_note", { title: "Handbook" }),
        statement("clm_five", { slot_key: SLOT, standing: "holds" }),
        statement("clm_seven", {
          slot_key: SLOT,
          standing: "disputed",
          held_unit_id: "clm_five",
          citations: [cite("spn_seven", "sv_GUIDE")],
        }),
        statement("clm_also", { title: "Calendar", slot_key: "carry_over" }),
      ]),
    );
    expect(
      page.facts.map((f) => [f.slot_key, f.current.map((h) => h.unit_id), f.against.map((h) => h.unit_id)]),
    ).toEqual([
      [SLOT, ["clm_five"], ["clm_seven"]],
      ["carry_over", ["clm_also"], []],
    ]);
    expect(page.facts.map((f) => f.disputed)).toEqual([true, false]);
    expect(page.others.map((h) => h.unit_id)).toEqual(["clm_note"]);
    expect([page.places, page.documents]).toEqual([4, 2]);
  });

  test("brings the value that holds from elsewhere when only an outdated one is placed here", () => {
    const held = statement("clm_five", { slot_key: SLOT, standing: "holds" });
    const page = pageOf(
      view([statement("clm_seven", { slot_key: SLOT, standing: "outdated", held_unit_id: "clm_five" })], [held]),
    );
    expect(page.facts).toHaveLength(1);
    expect(page.facts[0]?.current).toEqual([held]);
    expect(page.facts[0]?.disputed).toBe(false);
  });
});
