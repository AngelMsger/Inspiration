// What the usage page reads out of a month of usage: the budgets it shows, its figures in the
// reader's language, the months it offers and the scale of its charts.

import { readFileSync } from "node:fs";
import type { Usage } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import {
  axisTop,
  budgetsOf,
  byCost,
  costPerAnswer,
  daysOf,
  moneyText,
  perHundred,
  recentMonths,
  secondsText,
  spentShare,
} from "../src/usage.ts";

const usage = JSON.parse(
  readFileSync(new URL("../../../libs/contracts/examples/Usage.qinghe.json", import.meta.url), "utf8"),
) as Usage;

describe("budgets", () => {
  test("the pooled budget first, then the company's own, named by what they limit", () => {
    expect(budgetsOf(usage).map((l) => [l.budget.budget_key, l.component, l.words])).toEqual([
      ["*", undefined, undefined],
      [`tenant:${usage.tenant_id}/extraction`, "extraction", "usage.budget.extraction"],
      [`tenant:${usage.tenant_id}/retrieval`, "retrieval", "usage.budget.retrieval"],
    ]);
  });

  test("an unlimited budget says nothing, and a component without words keeps its name", () => {
    const lines = budgetsOf({
      ...usage,
      budgets: [
        { budget_key: "*", period: "month", spent: 3, currency: "CNY" },
        { budget_key: `tenant:${usage.tenant_id}/research`, period: "month", limit: 1, spent: 0, currency: "CNY" },
      ],
    });
    expect(lines).toEqual([expect.objectContaining({ component: "research" })]);
    expect(lines[0]?.words).toBeUndefined();
  });

  test("the share spent stops at the whole budget", () => {
    expect(spentShare({ budget_key: "*", period: "month", limit: 100, spent: 18.6, currency: "CNY" })).toBeCloseTo(
      0.186,
    );
    expect(spentShare({ budget_key: "*", period: "month", limit: 2, spent: 3, currency: "CNY" })).toBe(1);
  });
});

describe("figures", () => {
  test("todos per 100 documents, to one decimal, and none without documents", () => {
    expect(perHundred(usage.totals.todos, usage.totals.documents)).toBe(12.1);
    expect(perHundred(4, 0)).toBeUndefined();
    expect(perHundred(4, undefined)).toBeUndefined();
  });

  test("an answer's cost is the members' cost over their answers", () => {
    expect(costPerAnswer(usage)?.amount).toBeCloseTo(0.92 / 88);
    expect(costPerAnswer({ ...usage, by_member: [] })).toBeUndefined();
  });

  test("money keeps two decimals, and a small amount two significant digits", () => {
    expect(moneyText("en", usage.totals.cost)).toBe("CN¥12.84");
    expect(moneyText("en", { amount: 0.0042, currency: "CNY" })).toBe("CN¥0.0042");
    expect(moneyText("en", { amount: 0, currency: "CNY" })).toBe("CN¥0.00");
    expect(moneyText("zh", usage.totals.cost)).toBe("¥12.84");
  });

  test("times in seconds, to one decimal, and a dash without answers", () => {
    expect(secondsText("en", usage.totals.answer_ms_p50)).toBe("4.3s");
    expect(secondsText("en", 43)).toBe("0.043s");
    expect(secondsText("en", undefined)).toBe("–");
  });

  test("rows that cost the most first, then those that answered the most", () => {
    const row = (id: string, amount: number, answers: number) => ({
      ...usage.totals,
      space_id: id,
      cost: { amount, currency: "CNY" },
      answers,
    });
    expect(byCost([row("a", 1, 5), row("b", 2, 1), row("c", 1, 9)]).map((r) => r.space_id)).toEqual(["b", "c", "a"]);
  });
});

describe("months and charts", () => {
  test("the months offered run back from the current one, across the year", () => {
    expect(recentMonths("2026-02", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(recentMonths(usage.month)).toHaveLength(6);
  });

  test("a chart spans every day of its month", () => {
    expect(daysOf("2026-11")).toHaveLength(30);
    expect(daysOf("2028-02")).toHaveLength(29);
    expect(daysOf("2026-12").at(-1)).toBe("2026-12-31");
  });

  test("the top of the scale is the smallest 1, 2 or 5 times a power of ten that holds the largest day", () => {
    expect(usage.days.map((d) => axisTop(d.cost.amount))).toEqual([10, 5, 5]);
    expect(axisTop(Math.max(...usage.days.map((d) => d.answers)))).toBe(100);
    expect([0, 0.2, 0.41, 2, 40].map(axisTop)).toEqual([1, 0.2, 0.5, 2, 50]);
  });
});
