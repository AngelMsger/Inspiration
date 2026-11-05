/** Tenancy's records and where they are kept: in memory for tests, in Postgres (postgres.ts). */

import type { ProductRole, UiLocale } from "@inspiration/contracts/business";

/** A tenant, which the product calls a company. */
export interface Company {
  id: string;
  name: string;
  /** The language of messages sent to many members. */
  default_locale: UiLocale;
  /** Raised on every change; the engine keeps the highest it has seen. */
  version: number;
  created_at: string;
  /**
   * The sample company anyone may open (Tenancy's sample option). The engine keeps its record,
   * from a corpus, so it is never sent; its members only read, and nobody lists them.
   */
  sample?: true;
}

export type MemberStatus = "active" | "left";

/** An account inside one company. The key is (tenant_id, id): a member ID is unique only within its company. */
export interface Member {
  tenant_id: string;
  id: string;
  /** The account (usr_). It stays in the business layer: never sent to the engine. */
  user_id: string;
  role: ProductRole;
  status: MemberStatus;
  display_name: string;
  email: string;
  version: number;
  joined_at: string;
}

/** An invite link. Only the hash of its code is kept. */
export interface InviteRecord {
  id: string;
  tenant_id: string;
  code_hash: string;
  /** The super admin who made it. */
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  /** How many people joined through it. */
  joined: number;
}

export interface TenancyRecords {
  company(tenantId: string): Promise<Company | undefined>;
  companies(): Promise<Company[]>;
  putCompany(company: Company): Promise<void>;
  member(tenantId: string, memberId: string): Promise<Member | undefined>;
  memberByUser(tenantId: string, userId: string): Promise<Member | undefined>;
  /** Every member of a company, whatever their status. */
  members(tenantId: string): Promise<Member[]>;
  /** The account's members in every company, whatever their status. */
  membershipsOf(userId: string): Promise<Member[]>;
  putMember(member: Member): Promise<void>;
  invite(tenantId: string, inviteId: string): Promise<InviteRecord | undefined>;
  inviteByCode(codeHash: string): Promise<InviteRecord | undefined>;
  invites(tenantId: string): Promise<InviteRecord[]>;
  putInvite(invite: InviteRecord): Promise<void>;
}

export interface TenancyStore extends TenancyRecords {
  /**
   * Run fn in one transaction. With a company, it is locked first, so changes to that
   * company's members never interleave: the check that a company keeps a super admin holds.
   */
  transaction<T>(fn: (tx: TenancyRecords) => Promise<T>, lock?: string): Promise<T>;
}

const copy = structuredClone;

/** The test double: one transaction at a time, undone when fn throws. */
export class MemoryTenancy implements TenancyStore {
  #companies = new Map<string, Company>();
  #members = new Map<string, Member>();
  #invites = new Map<string, InviteRecord>();
  #queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: TenancyRecords) => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const saved = [copy(this.#companies), copy(this.#members), copy(this.#invites)] as const;
      try {
        return await fn(this);
      } catch (e) {
        [this.#companies, this.#members, this.#invites] = saved;
        throw e;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async company(tenantId: string) {
    return copy(this.#companies.get(tenantId));
  }

  async companies() {
    return copy([...this.#companies.values()]);
  }

  async putCompany(company: Company) {
    this.#companies.set(company.id, copy(company));
  }

  async member(tenantId: string, memberId: string) {
    return copy(this.#members.get(`${tenantId}|${memberId}`));
  }

  async memberByUser(tenantId: string, userId: string) {
    return copy([...this.#members.values()].find((m) => m.tenant_id === tenantId && m.user_id === userId));
  }

  async members(tenantId: string) {
    return copy([...this.#members.values()].filter((m) => m.tenant_id === tenantId));
  }

  async membershipsOf(userId: string) {
    return copy([...this.#members.values()].filter((m) => m.user_id === userId));
  }

  async putMember(member: Member) {
    this.#members.set(`${member.tenant_id}|${member.id}`, copy(member));
  }

  async invite(tenantId: string, inviteId: string) {
    const invite = this.#invites.get(inviteId);
    return invite?.tenant_id === tenantId ? copy(invite) : undefined;
  }

  async inviteByCode(codeHash: string) {
    return copy([...this.#invites.values()].find((i) => i.code_hash === codeHash));
  }

  async invites(tenantId: string) {
    return copy([...this.#invites.values()].filter((i) => i.tenant_id === tenantId));
  }

  async putInvite(invite: InviteRecord) {
    this.#invites.set(invite.id, copy(invite));
  }
}
