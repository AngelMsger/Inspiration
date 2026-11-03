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

  test("the right value giving way to another wherever it is a statement is demoted", () => {
    // An announcement's change, held back until a person decides: its passage still reaches the model.
    const announced = { text: "Meals are now covered up to $120 a day.", documents: ["handbook/travel.md"] };
    const page = { ...old, documents: ["handbook/travel.md"], standing: "holds" as const, unit: "clm_page" };
    const disputed = { ...announced, standing: "disputed" as const, unit: "clm_news", held: "clm_page" };
    expect(retentionOf(meals, raw, [announced, disputed, page])).toEqual({
      status: "demoted",
      documents: ["handbook/travel.md"],
    });
    expect(retentionOf(meals, raw, [announced, { ...announced, standing: "holds" as const }])).toEqual({
      status: "kept",
      documents: ["handbook/travel.md"],
    });
    // An older edition's statement gives way to its newer edition's, which states the same value.
    const edition = { ...announced, standing: "holds" as const, unit: "clm_new" };
    const older = { ...announced, standing: "outdated" as const, unit: "clm_old", held: "clm_new" };
    expect(retentionOf(meals, raw, [older, edition])?.status).toBe("kept");
    expect(retentionOf(meals, raw, [announced, { ...older, held: "clm_page" }, page])?.status).toBe("demoted");
  });

  test("where governed documents disagree, every value they state must be kept", () => {
    const lead: Question = {
      question: "How far ahead must a hotel be booked?",
      answer: ["7 days"],
      also: [["14 days"]],
      stale: [],
      cites: ["handbook/travel", "handbook/booking"],
      kind: "unchanged",
    };
    const policy = { text: "Book hotels 7 days ahead.", documents: ["handbook/travel.md"] };
    const booking = { text: "Book hotels 14 days ahead.", documents: ["handbook/booking.md"] };
    expect(retentionOf(lead, [policy, booking], [policy])).toEqual({
      status: "dropped",
      documents: ["handbook/booking.md"],
    });
    // Disputed is how an open disagreement should stand, so it is no loss here.
    expect(retentionOf(lead, [policy, booking], [policy, { ...booking, standing: "disputed" as const }])).toEqual({
      status: "kept",
      documents: ["handbook/travel.md", "handbook/booking.md"],
    });
  });

  test("documents the governed input cites beyond the raw one are listed", () => {
    expect(beyondRaw(raw, [current, { text: "x", documents: ["hr/salaries.md", "handbook/travel.md"] }])).toEqual([
      "hr/salaries.md",
    ]);
    expect(beyondRaw(raw, raw)).toEqual([]);
    expect(beyondRaw(null, raw)).toBeNull();
  });
});
