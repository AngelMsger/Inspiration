import type { PredicateEntry } from "@inspiration/extraction";
import { describe, expect, test } from "vitest";
import { keyedForm, predicateOfFact } from "../src/reading.ts";

type Entry = Pick<PredicateEntry, "value">;

describe("how the reading check compares a key's value with a slot's", () => {
  test("a numeric entry takes the key's one number with the entry's unit", () => {
    const days: Entry = { value: { kind: "duration", unit: "day" } };
    expect(keyedForm(days, "more than 3 days")).toBe("3 day");
    expect(keyedForm(days, "-3 days")).toBe("-3 day");
    expect(keyedForm({ value: { kind: "money", unit: "USD/transaction", currency: "USD" } }, "5,000 USD")).toBe(
      "5000 USD/transaction",
    );
    const event: Entry = { value: { kind: "money", unit: "USD/person/event", currency: "USD" } };
    expect(keyedForm(event, "20 USD per person per event")).toBe("20 USD/person/event");
    expect(keyedForm({ value: { kind: "number", unit: "address" } }, "256 addresses")).toBe("256 address");
    expect(keyedForm({ value: { kind: "number", unit: "volume" } }, "25")).toBe("25 volume");
    expect(keyedForm({ value: { kind: "percent", unit: "%" } }, "20%")).toBe("20 %");
    expect(keyedForm(days, "no set limit")).toBe("no set limit");
  });

  test("a unit, currency or order the entry does not have keeps the key's words", () => {
    const yearly: Entry = { value: { kind: "money", unit: "USD/year", currency: "USD" } };
    expect(keyedForm(yearly, "15 USD/quarter")).toBe("15 USD/quarter");
    expect(keyedForm(yearly, "15 (USD/quarter)")).toBe("15 (USD/quarter)");
    expect(keyedForm(yearly, "EUR 15/year")).toBe("EUR 15/year");
    expect(keyedForm(yearly, "$15/year")).toBe("15 USD/year");
    expect(keyedForm(yearly, "60 USD/year")).toBe("60 USD/year");
    expect(keyedForm({ value: { kind: "number", unit: "second/request" } }, "10 request/second")).toBe(
      "10 request/second",
    );
    expect(keyedForm({ value: { kind: "duration", unit: "hour" } }, "over 5 hours per segment")).toBe(
      "over 5 hours per segment",
    );
    expect(keyedForm({ value: { kind: "number" } }, "256 addresses")).toBe("256 addresses");
  });

  test("a unit symbol is not a plural", () => {
    expect(keyedForm({ value: { kind: "duration", unit: "m" } }, "3 ms")).toBe("3 ms");
    expect(keyedForm({ value: { kind: "duration", unit: "day" } }, "3 s")).toBe("3 s");
    expect(keyedForm({ value: { kind: "duration", unit: "ms" } }, "3 ms")).toBe("3 ms");
  });

  test("a negation, or a second number, keeps the key's words", () => {
    const days: Entry = { value: { kind: "duration", unit: "day" } };
    expect(keyedForm(days, "not more than 3 days")).toBe("not more than 3 days");
    expect(keyedForm(days, "3 to 5 days")).toBe("3 to 5 days");
    expect(keyedForm(days, "3-5 days")).toBe("3-5 days");
  });

  test("an enum takes the one listed value the key names, unless the key negates it", () => {
    const state: Entry = { value: { kind: "enum", values: ["alpha", "beta", "stable"] } };
    expect(keyedForm(state, "stable since v1.25")).toBe("stable");
    expect(keyedForm(state, "Beta")).toBe("beta");
    expect(keyedForm(state, "beta now, previously alpha")).toBe("beta now, previously alpha");
    expect(keyedForm(state, "not stable")).toBe("not stable");
    expect(keyedForm(state, "not yet stable")).toBe("not yet stable");
    expect(keyedForm(state, "never been stable")).toBe("never been stable");
    expect(keyedForm(state, "deprecated")).toBe("deprecated");
  });

  test("text, and a fact the catalogue lacks, compare as the key says them", () => {
    expect(keyedForm({ value: { kind: "text" } }, "all expenses")).toBe("all expenses");
    expect(keyedForm(undefined, "48 hours")).toBe("48 hours");
    expect(predicateOfFact("acme/hotel_cap|us|tier-1")).toBe("hotel_cap");
  });
});
