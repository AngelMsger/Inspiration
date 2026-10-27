/**
 * What a run's model calls cost at the gateway's prices, by task. With --dry-run the calls
 * are the stand-ins' and the numbers estimate what the configured models would be sent: the
 * input is the prompts a real run sends, cached input what a prefix cache would serve
 * (FakeProvider's prefix_cache), and the output the stand-ins' replies, which are shorter or
 * longer than a model's. Only an in-process gateway's usage is counted.
 */

import type { UsageRecord } from "@inspiration/contracts";
import { Gateway, MemoryUsage, type UsageSink } from "@inspiration/model-gateway";
import type { Engine } from "./engine.ts";

/**
 * A run's usage: every record kept for the cost report and written to a durable sink too
 * (PostgresUsage), whose sums the budgets read, so a day's budget counts that day's earlier
 * runs.
 */
export class RunUsage extends MemoryUsage {
  readonly durable: UsageSink;

  constructor(durable: UsageSink) {
    super();
    this.durable = durable;
  }

  override async record(rec: UsageRecord): Promise<void> {
    await super.record(rec);
    await this.durable.record(rec);
  }

  override spent(budgetKey: string, since: Date | undefined): Promise<number> {
    return this.durable.spent(budgetKey, since);
  }

  override spentMatching(match: string, since: Date | undefined): Promise<number> {
    return this.durable.spentMatching(match, since);
  }
}

export interface Spend {
  calls: number;
  /** Calls the response cache answered, at no cost. */
  cached_calls: number;
  input_tokens: number;
  /** Input tokens a provider's prefix cache served, at its cached price. */
  cached_input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface CostReport extends Spend {
  currency: string;
  by_task: Record<string, Spend>;
}

/** The metered calls from the from-th on, or none when the engine's gateway is not in process. */
export function usageSince(engine: Engine, from = 0): UsageRecord[] {
  const models = engine.models;
  return models instanceof Gateway && models.usage instanceof MemoryUsage ? models.usage.records.slice(from) : [];
}

export function spendOf(records: readonly UsageRecord[]): Spend {
  const sum = (f: (r: UsageRecord) => number) => records.reduce((n, r) => n + f(r), 0);
  return {
    calls: records.length,
    cached_calls: records.filter((r) => r.status === "cached").length,
    input_tokens: sum((r) => r.usage.input_tokens),
    cached_input_tokens: sum((r) => r.usage.cached_input_tokens ?? 0),
    output_tokens: sum((r) => r.usage.output_tokens),
    cost: Math.round(sum((r) => r.cost.amount) * 10_000) / 10_000,
  };
}

export function costReport(engine: Engine, from = 0): CostReport | undefined {
  const models = engine.models;
  if (!(models instanceof Gateway)) return undefined;
  const records = usageSince(engine, from);
  const tasks = [...new Set(records.map((r) => r.task ?? r.operation))].sort();
  return {
    currency: models.config.currency,
    ...spendOf(records),
    by_task: Object.fromEntries(tasks.map((t) => [t, spendOf(records.filter((r) => (r.task ?? r.operation) === t))])),
  };
}

export function spendLine(s: Spend, currency: string): string {
  return `${s.cost} ${currency}: ${s.calls} calls (${s.cached_calls} from the response cache), ${s.input_tokens} input tokens (${s.cached_input_tokens} from a prefix cache), ${s.output_tokens} output`;
}

export function costLines(r: CostReport, estimate: boolean): string[] {
  return [
    `model cost${estimate ? ", estimated from stand-ins" : ""}: ${spendLine(r, r.currency)}`,
    ...Object.entries(r.by_task).map(([task, s]) => `  ${task}: ${spendLine(s, r.currency)}`),
  ];
}
