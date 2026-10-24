import { describe, expect, test } from "vitest";
import { addWeeks, isoWeek, weekStart, weeksBetween } from "../src/weeks.ts";

describe("ISO weeks", () => {
  test("a week belongs to the year of its Thursday", () => {
    expect(isoWeek("2026-10-23")).toBe("2026-W43");
    expect(isoWeek(new Date("2026-10-26T00:00:00Z"))).toBe("2026-W44");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2025-12-29")).toBe("2026-W01");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2027-01-04")).toBe("2027-W01");
  });

  test("weeks start on Monday and count across years", () => {
    expect(weekStart("2026-W44")).toBe("2026-10-26");
    expect(weekStart("2026-W01")).toBe("2025-12-29");
    expect(addWeeks("2026-W52", 1)).toBe("2026-W53");
    expect(addWeeks("2026-W52", 2)).toBe("2027-W01");
    expect(weeksBetween("2026-W43", "2027-W01")).toBe(11);
    expect(weeksBetween("2026-W44", "2026-W43")).toBe(-1);
    expect(() => weekStart("2026-44")).toThrow(RangeError);
  });
});
