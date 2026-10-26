/** ISO 8601 weeks ("2026-W44"): weeks start on Monday, and week 1 holds the year's first Thursday. */

const DAY_MS = 86_400_000;
const WEEK = /^(\d{4})-W(\d{2})$/;

/** The ISO week of an instant or a day (YYYY-MM-DD), in UTC. */
export function isoWeek(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at.length === 10 ? `${at}T00:00:00Z` : at) : at;
  // The Thursday of the same week decides its year.
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (3 - day) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday a week starts on, YYYY-MM-DD. */
export function weekStart(week: string): string {
  const m = WEEK.exec(week);
  if (!m) throw new RangeError(`not an ISO week: ${week}`);
  const year = Number(m[1]);
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday + (Number(m[2]) - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

export function addWeeks(week: string, weeks: number): string {
  return isoWeek(new Date(Date.parse(`${weekStart(week)}T00:00:00Z`) + weeks * 7 * DAY_MS));
}

/** Weeks from one week to another: 0 for the same week, negative when `to` is earlier. */
export function weeksBetween(from: string, to: string): number {
  return Math.round((Date.parse(weekStart(to)) - Date.parse(weekStart(from))) / (7 * DAY_MS));
}
