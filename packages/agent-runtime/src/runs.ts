/** Agent run traces (agents.runs), kept for review, replay and evals. */

import type { AgentResult } from "@inspiration/contracts";
import type { Pool } from "@inspiration/kernel";

export interface RunStore {
  save(result: AgentResult, options: { principalId: string }): Promise<void>;
  get(runId: string): Promise<AgentResult | undefined>;
}

export class MemoryRuns implements RunStore {
  readonly runs = new Map<string, AgentResult>();

  async save(result: AgentResult): Promise<void> {
    this.runs.set(result.run_id, structuredClone(result));
  }

  async get(runId: string): Promise<AgentResult | undefined> {
    const run = this.runs.get(runId);
    return run && structuredClone(run);
  }
}

const UPSERT = `
INSERT INTO agents.runs (run_id, agent, version, status, trace_id, principal, started_at, finished_at, result)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
    result = excluded.result`;

export class PostgresRuns implements RunStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async save(r: AgentResult, options: { principalId: string }): Promise<void> {
    await this.pool.query(UPSERT, [
      r.run_id,
      r.agent,
      r.agent_version,
      r.status,
      r.trace_id,
      options.principalId,
      r.started_at,
      r.finished_at,
      JSON.stringify(r),
    ]);
  }

  async get(runId: string): Promise<AgentResult | undefined> {
    const { rows } = await this.pool.query<{ result: AgentResult }>(
      "SELECT result FROM agents.runs WHERE run_id = $1",
      [runId],
    );
    return rows[0]?.result;
  }
}
