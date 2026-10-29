import { describe, expect, test } from "vitest";
import { beyondRaw, type InputSource, type Question, retentionOf, says } from "../src/index.ts";

// The audit reads what each long context gives its model, never an answer: these fixtures carry
// the governed answer only to show the two can disagree.
const meals: Question = {
  question: "How much may a traveller spend on meals a day?",
  answer: ["$120"],
  stale: ["$100"],
  cites: ["handbook/travel"],
  kind: "changed",
};
const current: InputSource = { text: "Meals are covered up to $120 a day.", documents: ["handbook/travel.md"] };
const old: InputSource = { text: "Meals are covered up to $100 a day.", documents: ["handbook/travel.2025.md"] };
const raw = [current, old];

describe("the evidence audit", () => {
  test("evidence governance keeps is not a loss, though the answer over it is stale", () => {
    const governed = [current, { ...old, standing: "outdated" as const }];
    const answer = "Up to $100 a day.";
    expect([says(answer, meals.answer ?? []), says(answer, meals.stale)]).toEqual([false, true]);
    expect(retentionOf(meals, raw, governed)).toEqual({ status: "kept", documents: ["handbook/travel.md"] });
  });

  test("evidence governance drops is a loss, though the answer is right", () => {
    // The right value marked as one that no longer holds, and its passage gone.
    const governed = [old, { ...current, documents: ["handbook/travel.md"], standing: "outdated" as const }];
    const answer = "Up to $120 a day.";
    expect(says(answer, meals.answer ?? [])).toBe(true);
    expect(retentionOf(meals, raw, governed)).toEqual({ status: "dropped", documents: ["handbook/travel.md"] });
  });

  test("the right value from a document the key does not cite keeps nothing", () => {
    const copy = { text: current.text, documents: ["notes/trip.md"] };
    expect(retentionOf(meals, raw, [old, copy])).toEqual({ status: "dropped", documents: ["handbook/travel.md"] });
  });

  test("a value neither input states is absent, and a question without a key or an input is not audited", () => {
    expect(retentionOf(meals, [old], [old])).toEqual({ status: "absent", documents: [] });
    expect(retentionOf({ ...meals, answer: null }, raw, raw)).toBeNull();
    expect(retentionOf(meals, raw, null)).toBeNull();
    // Without the raw input, a value the governed one lacks may be dropped or absent.
    expect(retentionOf(meals, null, [old])).toBeNull();
    expect(retentionOf(meals, null, [current])).toEqual({ status: "kept", documents: ["handbook/travel.md"] });
  });

  test("documents the governed input cites beyond the raw one are listed", () => {
    expect(beyondRaw(raw, [current, { text: "x", documents: ["hr/salaries.md", "handbook/travel.md"] }])).toEqual([
      "hr/salaries.md",
    ]);
    expect(beyondRaw(raw, raw)).toEqual([]);
    expect(beyondRaw(null, raw)).toBeNull();
  });
});
