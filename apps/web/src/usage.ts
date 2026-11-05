// What the usage page reads out of a month of the company's usage (GET /v0/usage): its budgets,
// its figures in the reader's language, and the scale of its two charts. Only counts, times and
// cost reach the page; the engine never sends a question, an answer or a document.

import type { BudgetStatus, Money, Usage, UsageRow } from "@inspiration/contracts";
import type { Tag } from "./words.ts";

const locale = (tag: Tag) => (tag === "zh" ? "zh-CN" : tag);

/** The components a company's day budgets hold, by the words that name them. */
const COMPONENTS: Record<string, string> = {
  extraction: "usage.budget.extraction",
  retrieval: "usage.budget.retrieval",
  "page-compiler": "usage.budget.page_compiler",
};

/** A budget as the page shows it: whose spend it holds, spent against its limit. */
export interface BudgetLine {
  budget: BudgetStatus;
  /** The component, from a key such as tenant:<id>/extraction; absent for a pooled budget, whose key is its pattern. */
  component?: string;
  /** The words for what it limits; absent for a pooled budget and a component the page has no words for. */
  words?: string;
}

/**
 * The budgets with a limit, pooled ones first: a pooled budget's spend is every company's it
 * pools, any other is the company's own for one component. Unlimited budgets say nothing.
 */
export function budgetsOf(usage: Usage): BudgetLine[] {
  const own = `tenant:${usage.tenant_id}/`;
  const lines = usage.budgets
    .filter((b) => b.limit !== undefined)
    .map((budget): BudgetLine => {
      if (!budget.budget_key.startsWith(own)) return { budget };
      const component = budget.budget_key.slice(own.length);
      const words = COMPONENTS[component];
      return { budget, component, ...(words && { words }) };
    });
  return [...lines.filter((l) => !l.component), ...lines.filter((l) => l.component)];
}

/** How much of a budget is spent, from 0 to 1. */
export const spentShare = (b: BudgetStatus) => (b.limit ? Math.min(1, b.spent / b.limit) : 0);

/** Todos raised per 100 documents, to one decimal; absent without documents. */
export const perHundred = (todos: number, documents: number | undefined): number | undefined =>
  documents ? Math.round((todos / documents) * 1000) / 10 : undefined;

/** What an answer cost on average: the members' cost is their questions' and their agents'. */
export function costPerAnswer(usage: Usage): Money | undefined {
  const answers = usage.by_member.reduce((n, m) => n + m.answers, 0);
  if (answers === 0) return undefined;
  const amount = usage.by_member.reduce((n, m) => n + m.cost.amount, 0) / answers;
  return { amount, currency: usage.totals.cost.currency };
}

/** An amount of money in the reader's language; a small one keeps two significant digits. */
export function moneyText(tag: Tag, money: Money): string {
  const small = money.amount > 0 && money.amount < 0.1;
  return new Intl.NumberFormat(locale(tag), {
    style: "currency",
    currency: money.currency,
    ...(small ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(money.amount);
}

/** A time in seconds, to one decimal, or two significant digits under a second; a dash when there is none. */
export function secondsText(tag: Tag, ms: number | undefined): string {
  if (ms === undefined) return "–";
  return new Intl.NumberFormat(locale(tag), {
    style: "unit",
    unit: "second",
    unitDisplay: "narrow",
    ...(ms < 1000 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 }),
  }).format(ms / 1000);
}

/** A month such as 2026-11, as the reader's language names it. */
export const monthText = (tag: Tag, month: string) =>
  new Intl.DateTimeFormat(locale(tag), { year: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

/** A day such as 2026-11-03, short. */
export const dayText = (tag: Tag, date: string) =>
  new Intl.DateTimeFormat(locale(tag), { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

/** The month and the ones before it, newest first, that the page offers to read. */
export function recentMonths(month: string, count = 6): string[] {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(year, m - 1 - i, 1));
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Every day of a month, as 2026-11-01, so a chart spans the month whichever days have passed. */
export function daysOf(month: string): string[] {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Rows that cost the most first, then those that answered the most. */
export const byCost = <T extends UsageRow>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => b.cost.amount - a.cost.amount || b.answers - a.answers);

/** The top of a chart's scale: the smallest 1, 2 or 5 times a power of ten that holds the largest value. */
export function axisTop(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5].map((s) => s * power).find((top) => top >= max) ?? 10 * power;
}
