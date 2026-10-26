/** Usage records and budget accounting. Budgets are sums of metered cost per period. */

import type { BudgetPeriod, UsageRecord } from "@inspiration/contracts";
import type { Pool } from "@inspiration/kernel";

export interface UsageSink {
  record(rec: UsageRecord): Promise<void>;
  /** Total cost charged to the key since the given instant (or ever). */
  spent(budgetKey: string, since: Date | undefined): Promise<number>;
}

/** Milliseconds the zone's wall clock is ahead of UTC at the given instant. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(at / 1000) * 1000;
}

/** Start of the budget period containing now, in the given time zone; undefined for "total". */
export function periodStart(period: BudgetPeriod, now: Date, timeZone: string): Date | undefined {
  if (period === "total") return undefined;
  const local = new Date(now.getTime() + zoneOffset(now.getTime(), timeZone));
  const day = period === "day" ? local.getUTCDate() : 1;
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), day);
  // Local midnight as an instant; recomputed once in case the offset differs at midnight (DST).
  let start = midnight - zoneOffset(midnight, timeZone);
  start = midnight - zoneOffset(start, timeZone);
  return new Date(start);
}

export class MemoryUsage implements UsageSink {
  readonly records: UsageRecord[] = [];

  async record(rec: UsageRecord): Promise<void> {
    this.records.push(rec);
  }

  async spent(budgetKey: string, since: Date | undefined): Promise<number> {
    return this.records
      .filter((r) => r.budget_key === budgetKey && (since === undefined || new Date(r.at) >= since))
      .reduce((sum, r) => sum + r.cost.amount, 0);
  }
}

const INSERT = `
INSERT INTO gateway.usage (request_id, at, tenant_id, operation, task, prompt_version, budget_key, sensitivity,
    provider, model, status, input_tokens, output_tokens, cached_tokens, cost, currency, latency_ms, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
ON CONFLICT (request_id) DO NOTHING`;

/** Writes gateway.usage. Budget sums use the (budget_key, at) index. */
export class PostgresUsage implements UsageSink {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async record(r: UsageRecord): Promise<void> {
    await this.pool.query(INSERT, [
      r.request_id,
      r.at,
      r.tenant_id ?? null,
      r.operation,
      r.task ?? null,
      r.prompt_version ?? null,
      r.budget_key,
      r.sensitivity,
      r.provider ?? null,
      r.model ?? null,
      r.status,
      r.usage.input_tokens,
      r.usage.output_tokens,
      r.usage.cached_input_tokens ?? 0,
      r.cost.amount,
      r.cost.currency,
      r.latency_ms,
      r.error ?? null,
    ]);
  }

  async spent(budgetKey: string, since: Date | undefined): Promise<number> {
    const { rows } = await this.pool.query<{ spent: string }>(
      "SELECT coalesce(sum(cost), 0) AS spent FROM gateway.usage WHERE budget_key = $1 AND ($2::timestamptz IS NULL OR at >= $2)",
      [budgetKey, since ?? null],
    );
    return Number(rows[0]?.spent ?? 0);
  }
}
