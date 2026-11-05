/** Access grants' records and where they are kept: in memory for tests, in Postgres (postgres.ts). */

import type { Scope } from "@inspiration/contracts";
import type { TokenSpaces } from "@inspiration/contracts/business";

/** A personal access token. Only the hash of its secret is kept. */
export interface GrantRecord {
  /** tok_; the engine sees it as the agent token's grant. */
  id: string;
  tenant_id: string;
  /** The member it acts for. */
  member_id: string;
  name: string;
  spaces: TokenSpaces;
  scopes: Scope[];
  secret_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  /** To the minute. */
  last_used_at?: string;
}

export interface GrantStore {
  put(grant: GrantRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<GrantRecord | undefined>;
  bySecret(secretHash: string): Promise<GrantRecord | undefined>;
  /** Every token of a company, or of one member in it, whatever its state. */
  of(tenantId: string, memberId?: string): Promise<GrantRecord[]>;
}

const copy = structuredClone;

/** The test double. */
export class MemoryGrants implements GrantStore {
  readonly #grants = new Map<string, GrantRecord>();

  async put(grant: GrantRecord) {
    this.#grants.set(grant.id, copy(grant));
  }

  async get(tenantId: string, id: string) {
    const grant = this.#grants.get(id);
    return grant?.tenant_id === tenantId ? copy(grant) : undefined;
  }

  async bySecret(secretHash: string) {
    return copy([...this.#grants.values()].find((g) => g.secret_hash === secretHash));
  }

  async of(tenantId: string, memberId?: string) {
    return copy(
      [...this.#grants.values()].filter(
        (g) => g.tenant_id === tenantId && (memberId === undefined || g.member_id === memberId),
      ),
    );
  }
}
