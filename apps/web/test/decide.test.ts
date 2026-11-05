// What the inbox makes of Decide for me: the cards a press asks about, the marks on what the
// assistant left, the side it would choose, and its decisions in the reader's words.

import { readFileSync } from "node:fs";
import type { Decided, DecideTodos, InboxCard, InboxTodo, TaxonomyNode } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { chosenText, decideCards, decisionFact, marked, suggestedSide, toDecide } from "../src/decide.ts";
import { choiceText, sidesOf } from "../src/todos.ts";
import type { Say } from "../src/words.ts";

const en = parse(readFileSync(new URL("../languages/en.yaml", import.meta.url), "utf8")) as Record<string, string>;
const say: Say = (key, params) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => String(params?.[name] ?? m));
const example = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`../../../libs/contracts/examples/${name}.json`, import.meta.url), "utf8")) as T;

const decided = example<Decided>("Decided.hotel-cap");
const decision = decided.decisions[0] as Decided["decisions"][number];

const todo = (id: string, more: Partial<InboxTodo> = {}): InboxTodo => ({
  todo: { id, kind: "conflict", title: `Todo ${id}` } as InboxTodo["todo"],
  statements: [],
  choices: [
    { key: "choose:600 CNY/night", label: "Keep 600 CNY/night", value: "600 CNY/night" },
    { key: "choose:650 CNY/night", label: "Choose 650 CNY/night", value: "650 CNY/night" },
  ],
  ...more,
});
const card = (key: string, todos: InboxTodo[]): InboxCard => ({ batch_key: key, kind: "review", todos });

describe("Decide for me in the inbox", () => {
  test("marks what the assistant left, until the inbox read again holds its own mark", () => {
    const item = todo("todo_a");
    expect(marked(item, new Map())).toBe(item);
    const mark = {
      todo_id: "todo_a",
      reason: "Wang Fang left an open comment.",
      suggestion: { with: "x", reason: "y" },
    };
    expect(marked(item, new Map([["todo_a", mark]]))).toMatchObject({
      left: { reason: mark.reason },
      suggestion: mark.suggestion,
    });
    const own = todo("todo_a", { left: { reason: "The engine's" } });
    expect(marked(own, new Map([["todo_a", { todo_id: "todo_a", reason: "This visit's" }]])).left?.reason).toBe(
      "The engine's",
    );
    expect(marked(own, new Map([["todo_a", { todo_id: "todo_a", reason: "This visit's" }]]))).not.toHaveProperty(
      "suggestion",
    );
  });

  test("asks about the cards that hold a todo not left yet, one card at a time, in order", async () => {
    const cards = [
      card("card:1", [todo("todo_a", { left: { reason: "unsure" } })]),
      card("card:2", [todo("todo_b"), todo("todo_c", { left: { reason: "unsure" } })]),
      card("card:3", [todo("todo_d")]),
    ];
    expect(toDecide(cards).map((c) => c.batch_key)).toEqual(["card:2", "card:3"]);
    const asked: DecideTodos[] = [];
    const answers: Decided[] = [];
    await decideCards(
      toDecide(cards),
      async (a) => {
        asked.push(a);
        return decided;
      },
      (d) => answers.push(d),
    );
    expect(asked).toEqual([{ batch_key: "card:2" }, { batch_key: "card:3" }]);
    expect(answers).toHaveLength(2);
  });

  test("stops at a card that fails, having handed on the cards before it", async () => {
    const answers: Decided[] = [];
    const run = decideCards(
      [card("card:1", [todo("todo_a")]), card("card:2", [todo("todo_b")]), card("card:3", [todo("todo_c")])],
      async (a) => {
        if (a.batch_key === "card:2") throw new Error("down");
        return decided;
      },
      (d) => answers.push(d),
    );
    await expect(run).rejects.toThrow("down");
    expect(answers).toHaveLength(1);
  });

  test("selects the assistant's suggestion, else the value proposed first", () => {
    const plain = todo("todo_a");
    expect(suggestedSide(plain, sidesOf(plain))?.choice.value).toBe("600 CNY/night");
    const suggested = todo("todo_a", {
      suggestion: { with: "choose:650 CNY/night", reason: "The notice changed it." },
    });
    expect(suggestedSide(suggested, sidesOf(suggested))?.choice.value).toBe("650 CNY/night");
    const review = todo("todo_a", { choices: [], suggestion: { with: "confirm", reason: "Nothing changed." } });
    expect(suggestedSide(review, sidesOf(review))).toBeUndefined();
    const offered = { ...review, choices: [{ key: "confirm", label: "Still holds" }] };
    const side = suggestedSide(offered, sidesOf(offered));
    expect(side && choiceText(say, side.choice)).toBe("Still holds");
  });

  test("says what a decision chose in the reader's words, else by its label", () => {
    expect(chosenText(say, decision)).toBe("¥650 a night");
    expect(chosenText(say, { ...decision, todo: { ...decision.todo, resolutions: [] } })).toBe("Keep 650 CNY/night");
  });

  test("names a decision's fact as the inbox showed it, else as the catalogue or its topic calls it, else by its title", () => {
    const topic = { key: decision.todo.taxonomy_key, title: "Hotel cap" } as TaxonomyNode;
    const scope = decision.todo.slot_key?.split("|")[1];
    const { fact_label: _, ...unlabelled } = decision;
    expect(decisionFact(say, decision, "Hotel cap per night", [topic])).toBe("Hotel cap per night");
    expect(decisionFact(say, { ...decision, fact_label: "Hotel cap per night" }, undefined, [topic])).toBe(
      `Hotel cap per night (${scope})`,
    );
    expect(decisionFact(say, unlabelled, undefined, [topic])).toBe(`Hotel cap (${scope})`);
    expect(decisionFact(say, unlabelled, undefined, [])).toBe(decision.todo.title);
  });
});
