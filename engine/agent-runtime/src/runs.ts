/** Agent run traces (agents.runs), kept for review, replay and evals. */

import type { AgentResult, Principal } from "@inspiration/contracts";
import type { Pool } from "@inspiration/kernel";

/**
 * A run as kept: its result and who it ran as. That is for attribution and audit only; a
 * reader still needs its own permission check. tenant_id is absent on runs saved before runs
 * recorded their tenant.
 */
export interface StoredRun {
  tenant_id?: string;
  principal: string;
  on_behalf_of?: string;
  result: AgentResult;
}

export interface RunStore {
  /** Keep a run with the principal it ran as. */
  save(result: AgentResult, principal: Principal): Promise<void>;
  /** A run of the tenant. Another tenant's run, or one without a tenant, is not found. */
  get(tenantId: string, runId: string): Promise<StoredRun | undefined>;
  /**
   * A run of any tenant, for trusted offline work such as evals across tenants. Never on a
   * path that serves a member.
   */
  getAcrossTenants(runId: string): Promise<StoredRun | undefined>;
}

export class MemoryRuns implements RunStore {
  readonly runs = new Map<string, StoredRun>();

  async save(result: AgentResult, principal: Principal): Promise<void> {
    this.runs.set(result.run_id, structuredClone(stored(result, principal)));
  }

  async get(tenantId: string, runId: string): Promise<StoredRun | undefined> {
    const run = this.runs.get(runId);
    return run?.tenant_id === tenantId ? structuredClone(run) : undefined;
  }

  async getAcrossTenants(runId: string): Promise<StoredRun | undefined> {
    const run = this.runs.get(runId);
    return run && structuredClone(run);
  }
}

function stored(result: AgentResult, principal: Principal): StoredRun {
  return {
    tenant_id: principal.tenant_id,
    principal: principal.id,
    ...(principal.on_behalf_of && { on_behalf_of: principal.on_behalf_of }),
    result,
  };
}

const UPSERT = `
INSERT INTO agents.runs (run_id, agent, version, status, trace_id, tenant_id, principal, on_behalf_of, started_at,
    finished_at, result)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
    result = excluded.result`;

const SELECT = "SELECT tenant_id, principal, on_behalf_of, result FROM agents.runs WHERE run_id = $1";

interface Row {
  tenant_id: string | null;
  principal: string;
  on_behalf_of: string | null;
  result: AgentResult;
}

export class PostgresRuns implements RunStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async save(r: AgentResult, principal: Principal): Promise<void> {
    await this.pool.query(UPSERT, [
      r.run_id,
      r.agent,
      r.agent_version,
      r.status,
      r.trace_id,
      principal.tenant_id,
      principal.id,
      principal.on_behalf_of ?? null,
      r.started_at,
      r.finished_at,
      JSON.stringify(r),
    ]);
  }

  async get(tenantId: string, runId: string): Promise<StoredRun | undefined> {
    const { rows } = await this.pool.query<Row>(`${SELECT} AND tenant_id = $2`, [runId, tenantId]);
    return rows[0] && fromRow(rows[0]);
  }

  async getAcrossTenants(runId: string): Promise<StoredRun | undefined> {
    const { rows } = await this.pool.query<Row>(SELECT, [runId]);
    return rows[0] && fromRow(rows[0]);
  }
}

function fromRow(row: Row): StoredRun {
  return {
    ...(row.tenant_id !== null && { tenant_id: row.tenant_id }),
    principal: row.principal,
    ...(row.on_behalf_of !== null && { on_behalf_of: row.on_behalf_of }),
    result: row.result,
  };
}
