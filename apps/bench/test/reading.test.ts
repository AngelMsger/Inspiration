import type { PredicateEntry } from "@inspiration/extraction";
import { describe, expect, test } from "vitest";
import { keyedForm, predicateOfFact } from "../src/reading.ts";

describe("how the reading check compares a key's value with a slot's", () => {
  test("a numeric entry takes the key's first number with the entry's unit", () => {
    const days: Pick<PredicateEntry, "value"> = { value: { kind: "duration", unit: "day" } };
    expect(keyedForm(days, "more than 3 days")).toBe("3 day");
    expect(keyedForm(days, "-3 days")).toBe("-3 day");
    expect(keyedForm({ value: { kind: "money", unit: "USD/transaction", currency: "USD" } }, "5,000 USD")).toBe(
      "5000 USD/transaction",
    );
    expect(
      keyedForm({ value: { kind: "money", unit: "USD/person/event", currency: "USD" } }, "20 USD per person per event"),
    ).toBe("20 USD/person/event");
    expect(keyedForm({ value: { kind: "number", unit: "address" } }, "256 addresses")).toBe("256 address");
    expect(keyedForm(days, "no set limit")).toBe("no set limit");
  });

  test("a unit the entry lacks keeps the key's words, so a value read in another unit is not found", () => {
    const yearly: Pick<PredicateEntry, "value"> = { value: { kind: "money", unit: "USD/year", currency: "USD" } };
    expect(keyedForm(yearly, "15 USD/quarter")).toBe("15 USD/quarter");
    expect(keyedForm(yearly, "60 USD/year")).toBe("60 USD/year");
    expect(keyedForm({ value: { kind: "duration", unit: "hour" } }, "over 5 hours per segment")).toBe(
      "over 5 hours per segment",
    );
    expect(keyedForm({ value: { kind: "number" } }, "25")).toBe("25");
  });

  test("an enum takes the listed value the key names first, unless the key negates it", () => {
    const state: Pick<PredicateEntry, "value"> = { value: { kind: "enum", values: ["alpha", "beta", "stable"] } };
    expect(keyedForm(state, "stable since v1.25")).toBe("stable");
    expect(keyedForm(state, "Beta")).toBe("beta");
    expect(keyedForm(state, "beta now, previously alpha")).toBe("beta");
    expect(keyedForm(state, "not stable")).toBe("not stable");
    expect(keyedForm(state, "deprecated")).toBe("deprecated");
  });

  test("text, and a fact the catalogue lacks, compare as the key says them", () => {
    expect(keyedForm({ value: { kind: "text" } }, "all expenses")).toBe("all expenses");
    expect(keyedForm(undefined, "48 hours")).toBe("48 hours");
    expect(predicateOfFact("acme/hotel_cap|us|tier-1")).toBe("hotel_cap");
  });
});
