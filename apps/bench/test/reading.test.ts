import type { PredicateEntry } from "@inspiration/extraction";
import { describe, expect, test } from "vitest";
import { keyedForm, predicateOfFact } from "../src/reading.ts";

describe("how the reading check compares a key's value with a slot's", () => {
  test("a numeric entry takes the key's first number with the entry's unit", () => {
    const days: Pick<PredicateEntry, "value"> = { value: { kind: "duration", unit: "day" } };
    expect(keyedForm(days, "more than 3 days")).toBe("3 day");
    expect(keyedForm({ value: { kind: "money", unit: "USD/transaction", currency: "USD" } }, "5,000 USD")).toBe(
      "5000 USD/transaction",
    );
    expect(keyedForm({ value: { kind: "number" } }, "256 addresses")).toBe("256");
    expect(keyedForm(days, "no set limit")).toBe("no set limit");
  });

  test("an enum takes the first listed value the key names as a word", () => {
    const state: Pick<PredicateEntry, "value"> = { value: { kind: "enum", values: ["alpha", "beta", "stable"] } };
    expect(keyedForm(state, "stable since v1.25")).toBe("stable");
    expect(keyedForm(state, "Beta")).toBe("beta");
    expect(keyedForm(state, "deprecated")).toBe("deprecated");
  });

  test("text, and a fact the catalogue lacks, compare as the key says them", () => {
    expect(keyedForm({ value: { kind: "text" } }, "all expenses")).toBe("all expenses");
    expect(keyedForm(undefined, "48 hours")).toBe("48 hours");
    expect(predicateOfFact("acme/hotel_cap|us|tier-1")).toBe("hotel_cap");
  });
});
