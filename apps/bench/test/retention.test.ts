import { testData } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { beyondRaw, type InputSource, keepsMeaning, type Question, retentionOf, says } from "../src/index.ts";

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

interface MeaningCases {
  answer: string[];
  quote: string;
  kept: string[];
  apart: string;
  denied: string[];
  narrowed: string[];
  condition: string[];
}

const LANGUAGES = ["en", "ja", "zh"].map((tag) => ({
  tag,
  ...testData<{ audit: MeaningCases }>(import.meta.url, `${tag}.yaml`).audit,
}));

describe.each(LANGUAGES)("the evidence audit reads what a value means in $tag", (c) => {
  const quotes = [c.quote];

  test("a value stated with the key's meaning keeps it, bounded or widened, beside a negation of its own", () => {
    for (const text of [c.quote, ...c.kept, c.apart]) expect(keepsMeaning(text, c.answer, quotes), text).toBe(true);
  });

  test("a value stated only denied, or narrowed where the key does not narrow it, does not", () => {
    for (const text of [...c.denied, ...c.narrowed]) expect(keepsMeaning(text, c.answer, quotes), text).toBe(false);
  });

  test("a key that names the value's condition keeps it only where the source names it", () => {
    for (const text of c.narrowed) expect(keepsMeaning(text, c.answer, quotes, c.condition), text).toBe(true);
    expect(keepsMeaning(c.quote, c.answer, quotes, c.condition)).toBe(false);
  });

  test("governance that gives the value only with another meaning changes it", () => {
    const q: Question = {
      question: "?",
      answer: c.answer,
      cites: ["handbook/travel"],
      quotes: [quotes],
      kind: "unchanged",
    };
    const of = (text: string): InputSource => ({ text, documents: ["handbook/travel.md"] });
    const changed = { status: "changed_meaning", documents: ["handbook/travel.md"] };
    expect(retentionOf(q, [of(c.quote)], c.denied.map(of))).toEqual(changed);
    expect(retentionOf(q, null, c.narrowed.map(of))).toEqual(changed);
    expect(retentionOf(q, null, [...c.denied.map(of), of(c.apart)])?.status).toBe("kept");
    const only = { ...q, condition: c.condition };
    expect(retentionOf(only, null, [of(c.quote)])).toEqual(changed);
    expect(retentionOf(only, null, c.narrowed.map(of))?.status).toBe("kept");
  });
});

test("a source that holds the key's quote keeps its meaning, whatever the sentence after it says", () => {
  // A list joined into one line runs on into the sentence that bounds the whole list.
  const text =
    "The kubelet has the following default hard eviction thresholds: nodefs.available<10% imagefs.available<15% " +
    "These defaults are only set if none of the parameters is changed.";
  expect(keepsMeaning(text, ["15%"], ["imagefs.available<15%"])).toBe(true);
  expect(keepsMeaning(text, ["15%"], ["The default threshold is 15%."])).toBe(false);
});

test("a question without a key names no meaning, so a source stating its value keeps it", () => {
  const denied: InputSource = { text: "Meals are not covered up to $120 a day.", documents: ["handbook/travel.md"] };
  expect(retentionOf(meals, null, [denied])?.status).toBe("kept");
  expect(retentionOf({ ...meals, quotes: [["Meals are covered up to $120 a day."]] }, null, [denied])?.status).toBe(
    "changed_meaning",
  );
});

describe("what the words around a value do to it", () => {
  const texts = ["120"];
  const quote = "Meals are covered up to $120 a day.";

  test("words before a quote that deny or narrow it count against it", () => {
    expect(keepsMeaning("The following statement is false: Meals are covered up to $120 a day.", texts, [quote])).toBe(
      false,
    );
    expect(keepsMeaning("Only for executives: Meals are covered up to $120 a day.", texts, [quote])).toBe(false);
  });

  test("a value keeps its polarity: a quote that denies it is not kept by a source that grants it", () => {
    const denied = "Meals are not covered up to $120 a day.";
    expect(keepsMeaning(quote, texts, [denied])).toBe(false);
    expect(keepsMeaning("Meals are never covered up to $120 a day.", texts, [denied])).toBe(true);
  });

  test("a value that holds for someone loses its condition when the source drops it", () => {
    const executives = "Meals are covered up to $120 a day only for executives.";
    expect(keepsMeaning("Meals are covered up to $120 a day.", texts, [executives])).toBe(false);
  });

  test("the condition must be in the clause that states the value", () => {
    const executives = "Meals are covered up to $120 a day only for executives.";
    const elsewhere = "Executives have parking. Meals are covered up to $120 a day only for interns.";
    expect(keepsMeaning(elsewhere, texts, [executives], ["executives"])).toBe(false);
    expect(keepsMeaning("Executives may claim meals up to $120 a day.", texts, [executives], ["executives"])).toBe(
      true,
    );
  });
});
