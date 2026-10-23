import { describe, expect, test } from "vitest";
import { DEFAULT_INTERVALS, reviewInterval, staleness } from "../src/index.ts";

describe("freshness rules", () => {
  test("the shortest interval among a document's classes applies; general and unknown classes never come due", () => {
    expect(reviewInterval(["policy", "pricing", "general"], DEFAULT_INTERVALS)).toEqual({
      knowledge_class: "pricing",
      days: 90,
    });
    expect(reviewInterval(["general", "supplier"], DEFAULT_INTERVALS)).toBeUndefined();
    // A tenant's own classes and intervals replace the defaults.
    expect(reviewInterval(["supplier", "policy"], { supplier: 30, policy: 365, general: null })).toEqual({
      knowledge_class: "supplier",
      days: 30,
    });
  });

  test("staleness ages with the interval, and a changed original or a lapsed plan puts it at risk", () => {
    const now = new Date("2026-10-23T09:00:00Z");
    const clock = { changed_on: "2026-01-01", interval_days: 365, behind: false, lapsed: false };
    expect(staleness("sv_01JC00000000000000000001", clock, now)).toMatchObject({
      state: "aging",
      score: 0.808,
      ttl: "P365D",
      review_due: "2027-01-01T00:00:00Z",
    });
    expect(staleness("sv_01JC00000000000000000001", { ...clock, changed_on: "2025-01-01" }, now)).toMatchObject({
      state: "stale",
      score: 1,
    });
    expect(staleness("sv_01JC00000000000000000001", { ...clock, behind: true }, now)).toMatchObject({
      state: "at_risk",
      upstream_component: 1,
    });
    const record = staleness(
      "sv_01JC00000000000000000001",
      { changed_on: "2020-01-01", behind: false, lapsed: false },
      now,
    );
    expect(record).toMatchObject({ state: "fresh", score: 0 });
    expect(record.review_due).toBeUndefined();
  });
});
