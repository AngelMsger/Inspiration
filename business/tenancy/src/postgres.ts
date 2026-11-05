/** Tenancy's records in Postgres, in the tenancy schema (migrations/). */

import type { Pool, Queryable } from "@inspiration/kernel";
import { withTransaction } from "@inspiration/kernel";
import type { Company, InviteRecord, Member, TenancyRecords, TenancyStore } from "./store.ts";

const iso = (d: Date) => d.toISOString();

interface CompanyRow {
  tenant_id: string;
  name: string;
  default_locale: Company["default_locale"];
  version: number;
  created_at: Date;
}

interface MemberRow extends Omit<Member, "tenant_id" | "id" | "joined_at"> {
  tenant_id: string;
  member_id: string;
  joined_at: Date;
}

interface InviteRow extends Omit<InviteRecord, "id" | "created_at" | "expires_at" | "revoked_at"> {
  invite_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const companyOf = (r: CompanyRow): Company => ({
  id: r.tenant_id,
  name: r.name,
  default_locale: r.default_locale,
  version: r.version,
  created_at: iso(r.created_at),
});

const memberOf = ({ member_id, joined_at, ...r }: MemberRow): Member => ({
  ...r,
  id: member_id,
  joined_at: iso(joined_at),
});

const inviteOf = ({ invite_id, created_at, expires_at, revoked_at, ...r }: InviteRow): InviteRecord => ({
  ...r,
  id: invite_id,
  created_at: iso(created_at),
  expires_at: iso(expires_at),
  ...(revoked_at && { revoked_at: iso(revoked_at) }),
});

const MEMBER = "SELECT * FROM tenancy.members";
const INVITE = "SELECT * FROM tenancy.invites";

/** Reads and writes on one connection or pool, inside a transaction or not. */
class Records implements TenancyRecords {
  readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async #rows<R>(sql: string, params: unknown[]): Promise<R[]> {
    return (await this.db.query(sql, params)).rows as R[];
  }

  async company(tenantId: string) {
    const [row] = await this.#rows<CompanyRow>("SELECT * FROM tenancy.companies WHERE tenant_id = $1", [tenantId]);
    return row && companyOf(row);
  }

  async companies() {
    return (await this.#rows<CompanyRow>("SELECT * FROM tenancy.companies ORDER BY tenant_id", [])).map(companyOf);
  }

  async putCompany(c: Company) {
    await this.db.query(
      `INSERT INTO tenancy.companies (tenant_id, name, default_locale, version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET name = excluded.name, default_locale = excluded.default_locale,
         version = excluded.version`,
      [c.id, c.name, c.default_locale, c.version, c.created_at],
    );
  }

  async member(tenantId: string, memberId: string) {
    const [row] = await this.#rows<MemberRow>(`${MEMBER} WHERE tenant_id = $1 AND member_id = $2`, [
      tenantId,
      memberId,
    ]);
    return row && memberOf(row);
  }

  async memberByUser(tenantId: string, userId: string) {
    const [row] = await this.#rows<MemberRow>(`${MEMBER} WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    return row && memberOf(row);
  }

  async members(tenantId: string) {
    return (await this.#rows<MemberRow>(`${MEMBER} WHERE tenant_id = $1 ORDER BY member_id`, [tenantId])).map(memberOf);
  }

  async membershipsOf(userId: string) {
    return (await this.#rows<MemberRow>(`${MEMBER} WHERE user_id = $1 ORDER BY tenant_id`, [userId])).map(memberOf);
  }

  async putMember(m: Member) {
    await this.db.query(
      `INSERT INTO tenancy.members (tenant_id, member_id, user_id, role, status, display_name, email, version, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, member_id) DO UPDATE SET role = excluded.role, status = excluded.status,
         display_name = excluded.display_name, email = excluded.email, version = excluded.version,
         joined_at = excluded.joined_at`,
      [m.tenant_id, m.id, m.user_id, m.role, m.status, m.display_name, m.email, m.version, m.joined_at],
    );
  }

  async invite(tenantId: string, inviteId: string) {
    const [row] = await this.#rows<InviteRow>(`${INVITE} WHERE tenant_id = $1 AND invite_id = $2`, [
      tenantId,
      inviteId,
    ]);
    return row && inviteOf(row);
  }

  async inviteByCode(codeHash: string) {
    const [row] = await this.#rows<InviteRow>(`${INVITE} WHERE code_hash = $1`, [codeHash]);
    return row && inviteOf(row);
  }

  async invites(tenantId: string) {
    return (await this.#rows<InviteRow>(`${INVITE} WHERE tenant_id = $1 ORDER BY invite_id`, [tenantId])).map(inviteOf);
  }

  async putInvite(i: InviteRecord) {
    await this.db.query(
      `INSERT INTO tenancy.invites (invite_id, tenant_id, code_hash, created_by, created_at, expires_at, revoked_at, joined)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (invite_id) DO UPDATE SET revoked_at = excluded.revoked_at, joined = excluded.joined`,
      [i.id, i.tenant_id, i.code_hash, i.created_by, i.created_at, i.expires_at, i.revoked_at ?? null, i.joined],
    );
  }
}

export class PostgresTenancy extends Records implements TenancyStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    super(pool);
    this.pool = pool;
  }

  transaction<T>(fn: (tx: TenancyRecords) => Promise<T>, lock?: string): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      if (lock) await client.query("SELECT 1 FROM tenancy.companies WHERE tenant_id = $1 FOR UPDATE", [lock]);
      return fn(new Records(client));
    });
  }
}
