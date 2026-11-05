/** Access grants' records in Postgres, in the access_grants schema (migrations/). */

import type { Scope } from "@inspiration/contracts";
import type { Pool } from "@inspiration/kernel";
import type { GrantRecord, GrantStore } from "./store.ts";

interface Row {
  token_id: string;
  tenant_id: string;
  member_id: string;
  name: string;
  spaces: string[] | null;
  scopes: Scope[];
  secret_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

const grantOf = (r: Row): GrantRecord => ({
  id: r.token_id,
  tenant_id: r.tenant_id,
  member_id: r.member_id,
  name: r.name,
  spaces: r.spaces ? (r.spaces as GrantRecord["spaces"]) : "all",
  scopes: r.scopes,
  secret_hash: r.secret_hash,
  created_at: r.created_at.toISOString(),
  expires_at: r.expires_at.toISOString(),
  ...(r.revoked_at && { revoked_at: r.revoked_at.toISOString() }),
  ...(r.last_used_at && { last_used_at: r.last_used_at.toISOString() }),
});

const SELECT = "SELECT * FROM access_grants.tokens";

export class PostgresGrants implements GrantStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async #rows(sql: string, params: unknown[]): Promise<GrantRecord[]> {
    return ((await this.pool.query(sql, params)).rows as Row[]).map(grantOf);
  }

  async put(g: GrantRecord) {
    await this.pool.query(
      `INSERT INTO access_grants.tokens (token_id, tenant_id, member_id, name, spaces, scopes, secret_hash,
         created_at, expires_at, revoked_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (token_id) DO UPDATE SET revoked_at = excluded.revoked_at, last_used_at = excluded.last_used_at`,
      [
        g.id,
        g.tenant_id,
        g.member_id,
        g.name,
        g.spaces === "all" ? null : g.spaces,
        g.scopes,
        g.secret_hash,
        g.created_at,
        g.expires_at,
        g.revoked_at ?? null,
        g.last_used_at ?? null,
      ],
    );
  }

  async get(tenantId: string, id: string) {
    return (await this.#rows(`${SELECT} WHERE tenant_id = $1 AND token_id = $2`, [tenantId, id]))[0];
  }

  async bySecret(secretHash: string) {
    return (await this.#rows(`${SELECT} WHERE secret_hash = $1`, [secretHash]))[0];
  }

  async of(tenantId: string, memberId?: string) {
    return memberId === undefined
      ? this.#rows(`${SELECT} WHERE tenant_id = $1`, [tenantId])
      : this.#rows(`${SELECT} WHERE tenant_id = $1 AND member_id = $2`, [tenantId, memberId]);
  }
}
