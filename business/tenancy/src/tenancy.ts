/** Companies, their members and invite links: the rules, over a TenancyStore and the engine's directory. */

import { createHash, randomBytes } from "node:crypto";
import { newId, ulid } from "@inspiration/contracts";
import type { ProductRole, UiLocale } from "@inspiration/contracts/business";
import { logger } from "@inspiration/kernel";
import type { Company, InviteRecord, Member, TenancyRecords, TenancyStore } from "./store.ts";

const log = logger("tenancy");

/** How long an invite link stays open. */
export const INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** The engine's copy of the directory, provisioned as a service. Calls are idempotent. */
export interface EngineDirectory {
  putTenant(company: Company): Promise<void>;
  putMember(member: Member): Promise<void>;
}

/** The account, as tenancy needs it: the business layer's own user ID and how to name them. */
export interface Person {
  userId: string;
  name: string;
  email: string;
}

/** A member and the company they are in. */
export interface Membership {
  company: Company;
  member: Member;
}

export type TenancyErrorCode = "forbidden" | "conflict";

/** A request tenancy refuses. Unknown IDs and codes raise RangeError instead, read as not found. */
export class TenancyError extends Error {
  override name = "TenancyError";
  readonly code: TenancyErrorCode;
  constructor(code: TenancyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The one rule that assigns a member ID, applied when an account first joins a company. In
 * phase 1 it reuses the user ID's body under the member prefix, so one person has the same
 * member ID everywhere; it may later mint a fresh ID per company, for new members only. Nothing
 * else derives one ID from the other or reads an ID's body: the account is found only through
 * the member record.
 */
export function assignMemberId(userId: string): string {
  const body = /^usr_([0-9A-Za-z]{8,64})$/.exec(userId)?.[1];
  if (!body) throw new RangeError(`${userId} is not a user ID`);
  return `mem_${body}`;
}

/**
 * The engine's internal roles each product role bundles. The super admin holds the four the
 * engine keeps apart, so a later split into separate system, security and audit admins
 * changes only this bundle.
 */
export function engineRoles(role: ProductRole): string[] {
  return role === "super_admin" ? ["owner", "admin", "security_admin", "auditor"] : ["member"];
}

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");

/** The sample company as configured: the engine already holds its record and its knowledge. */
export type SampleCompany = Pick<Company, "id" | "name" | "default_locale">;

export class Tenancy {
  readonly store: TenancyStore;
  readonly engine: EngineDirectory;
  /** The sample company anyone may open on this site, if it has one. */
  readonly sample?: Company;
  readonly #now: () => Date;

  constructor(
    store: TenancyStore,
    engine: EngineDirectory,
    options: { clock?: () => Date; sample?: SampleCompany } = {},
  ) {
    this.store = store;
    this.engine = engine;
    this.#now = options.clock ?? (() => new Date());
    if (options.sample) {
      this.sample = { ...options.sample, version: 1, created_at: this.#now().toISOString(), sample: true };
    }
  }

  /** The companies the account is an active member of, by name; the sample company is not one of them. */
  async companiesOf(userId: string): Promise<Membership[]> {
    const out: Membership[] = [];
    for (const member of await this.store.membershipsOf(userId)) {
      const company = member.status === "active" ? await this.store.company(member.tenant_id) : undefined;
      if (company && !company.sample) out.push({ company, member });
    }
    return out.sort((a, b) => a.company.name.localeCompare(b.company.name) || a.company.id.localeCompare(b.company.id));
  }

  /** The account's membership of one company, if it is active; of the sample company, while this site offers it. */
  async membership(tenantId: string, userId: string): Promise<Membership | undefined> {
    const member = await this.store.memberByUser(tenantId, userId);
    const company = member?.status === "active" ? await this.store.company(tenantId) : undefined;
    return company && member && this.#offered(company) ? { company, member } : undefined;
  }

  /** A member by ID, with their company, while they are active in it and this site offers it. */
  async activeMember(tenantId: string, memberId: string): Promise<Membership | undefined> {
    const member = await this.store.member(tenantId, memberId);
    const company = member?.status === "active" ? await this.store.company(tenantId) : undefined;
    return company && member && this.#offered(company) ? { company, member } : undefined;
  }

  /**
   * Open the sample company: the account joins it as a member the first time, and its member
   * is sent to the engine every time, so it is there again after the engine restarted.
   */
  async visit(person: Person): Promise<Membership> {
    const sample = this.sample;
    if (!sample) throw new RangeError("this site has no sample company");
    const member = await this.store.transaction(async (tx) => {
      const before = await tx.memberByUser(sample.id, person.userId);
      if (before) return before;
      await tx.putCompany(sample);
      const member = this.#newMember(sample.id, person, "member", this.#now().toISOString());
      await tx.putMember(member);
      return member;
    });
    await this.engine.putMember(member);
    return { company: sample, member };
  }

  /** A new company, with the account as its first super admin. */
  async create(person: Person, input: { name: string; default_locale: UiLocale }): Promise<Membership> {
    const now = this.#now().toISOString();
    const company: Company = { id: newId("tenant"), ...input, version: 1, created_at: now };
    const member = this.#newMember(company.id, person, "super_admin", now);
    await this.store.transaction(async (tx) => {
      await tx.putCompany(company);
      await tx.putMember(member);
    });
    await this.engine.putTenant(company);
    await this.engine.putMember(member);
    return { company, member };
  }

  /** The active members of the actor's company, by name. The sample company's visitors are not listed. */
  async members(actor: Member): Promise<Member[]> {
    await this.#active(this.store, actor);
    if ((await this.store.company(actor.tenant_id))?.sample) {
      throw new TenancyError("forbidden", "the sample company's members are not listed");
    }
    return (await this.store.members(actor.tenant_id))
      .filter((m) => m.status === "active")
      .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id));
  }

  /** Change a member's product role. A company always keeps a super admin. */
  async setRole(actor: Member, memberId: string, role: ProductRole): Promise<Member> {
    const changed = await this.store.transaction(async (tx) => {
      await this.#superAdmin(tx, actor);
      const member = await this.#activeMember(tx, actor.tenant_id, memberId);
      if (member.role === role) return member;
      if (role !== "super_admin") await this.#keepsSuperAdmin(tx, member);
      const next = { ...member, role, version: member.version + 1 };
      await tx.putMember(next);
      return next;
    }, actor.tenant_id);
    await this.engine.putMember(changed);
    return changed;
  }

  /**
   * Remove a member from the company: they leave, and the engine drops every grant they hold.
   * Removing someone who already left sends their record to the engine again, so a removal
   * whose engine call failed can be repeated.
   */
  async remove(actor: Member, memberId: string): Promise<void> {
    const removed = await this.store.transaction(async (tx) => {
      await this.#superAdmin(tx, actor);
      const member = await tx.member(actor.tenant_id, memberId);
      if (!member) throw new RangeError(`no member ${memberId}`);
      if (member.status === "left") return member;
      await this.#keepsSuperAdmin(tx, member);
      const next: Member = { ...member, status: "left", version: member.version + 1 };
      await tx.putMember(next);
      return next;
    }, actor.tenant_id);
    await this.engine.putMember(removed);
  }

  /** Copy a renamed account's name to its members in every company. */
  async rename(person: Person): Promise<void> {
    for (const member of await this.store.membershipsOf(person.userId)) {
      const renamed = await this.store.transaction(async (tx) => {
        const current = await tx.member(member.tenant_id, member.id);
        if (!current || current.display_name === person.name) return undefined;
        const next = { ...current, display_name: person.name, version: current.version + 1 };
        await tx.putMember(next);
        const company = await tx.company(member.tenant_id);
        return company && this.#offered(company) ? next : undefined;
      }, member.tenant_id);
      if (renamed?.status === "active") await this.engine.putMember(renamed);
    }
  }

  /** A new invite link. Its code is returned this once; only its hash is kept. */
  async invite(actor: Member): Promise<{ invite: InviteRecord; code: string }> {
    const code = randomBytes(24).toString("base64url");
    const now = this.#now();
    const invite: InviteRecord = {
      id: `inv_${ulid()}`,
      tenant_id: actor.tenant_id,
      code_hash: hashOf(code),
      created_by: actor.id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + INVITE_DAYS * DAY).toISOString(),
      joined: 0,
    };
    await this.store.transaction(async (tx) => {
      await this.#superAdmin(tx, actor);
      await tx.putInvite(invite);
    }, actor.tenant_id);
    return { invite, code };
  }

  /** The company's links that are still open, newest first. */
  async invites(actor: Member): Promise<InviteRecord[]> {
    await this.#superAdmin(this.store, actor);
    const open = [];
    for (const invite of await this.store.invites(actor.tenant_id)) {
      if (await this.#open(this.store, invite)) open.push(invite);
    }
    return open.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  }

  /** Close a link at once. Revoking a closed or revoked link changes nothing. */
  async revoke(actor: Member, inviteId: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      await this.#superAdmin(tx, actor);
      const invite = await tx.invite(actor.tenant_id, inviteId);
      if (!invite) throw new RangeError(`no invite ${inviteId}`);
      if (!invite.revoked_at) await tx.putInvite({ ...invite, revoked_at: this.#now().toISOString() });
    }, actor.tenant_id);
  }

  /** What a link would join, for anyone holding it; undefined for a code that is unknown or closed. */
  async preview(code: string): Promise<{ company: Company; invitedBy: Member; invite: InviteRecord } | undefined> {
    const invite = await this.store.inviteByCode(hashOf(code));
    const invitedBy = invite && (await this.#open(this.store, invite));
    const company = invitedBy && (await this.store.company(invitedBy.tenant_id));
    return invite && invitedBy && company && { company, invitedBy, invite };
  }

  /**
   * Join the company of an open link as a member. An account that is already a member stays as
   * it is; one that left comes back as a member, with the member ID it had.
   */
  async join(person: Person, code: string): Promise<Membership> {
    const found = await this.store.inviteByCode(hashOf(code));
    if (!found) throw new RangeError("no such invite");
    const joined = await this.store.transaction(async (tx) => {
      const invite = await tx.invite(found.tenant_id, found.id);
      if (!invite || !(await this.#open(tx, invite))) throw new RangeError("no such invite");
      const company = (await tx.company(invite.tenant_id)) as Company;
      const before = await tx.memberByUser(invite.tenant_id, person.userId);
      if (before?.status === "active") return { company, member: before, changed: false };
      const now = this.#now().toISOString();
      const member: Member = before
        ? {
            ...before,
            role: "member",
            status: "active",
            display_name: person.name,
            email: person.email,
            version: before.version + 1,
          }
        : this.#newMember(invite.tenant_id, person, "member", now);
      await tx.putMember(member);
      await tx.putInvite({ ...invite, joined: invite.joined + 1 });
      return { company, member, changed: true };
    }, found.tenant_id);
    if (joined.changed) await this.engine.putMember(joined.member);
    return { company: joined.company, member: joined.member };
  }

  /**
   * Send every company and member to the engine again, as the backend does when it starts, so
   * the engine's copy catches up with any call that failed. The sample company's visitors are
   * sent, never its record. Answers how many records it sent.
   */
  async resync(): Promise<number> {
    let sent = 0;
    for (const company of await this.store.companies()) {
      if (!this.#offered(company)) continue;
      if (!company.sample) {
        await this.engine.putTenant(company);
        sent++;
      }
      for (const member of await this.store.members(company.id)) {
        await this.engine.putMember(member);
        sent++;
      }
    }
    log.info("directory sent to the engine", { records: sent });
    return sent;
  }

  #newMember(tenantId: string, person: Person, role: ProductRole, now: string): Member {
    return {
      tenant_id: tenantId,
      id: assignMemberId(person.userId),
      user_id: person.userId,
      role,
      status: "active",
      display_name: person.name,
      email: person.email,
      version: 1,
      joined_at: now,
    };
  }

  /** Whether the engine holds the company: every company but a sample one this site no longer offers. */
  #offered(company: Company): boolean {
    return !company.sample || company.id === this.sample?.id;
  }

  /** The actor as stored now: still an active member of their company. */
  async #active(tx: TenancyRecords, actor: Member): Promise<Member> {
    const current = await tx.member(actor.tenant_id, actor.id);
    if (current?.status !== "active") throw new TenancyError("forbidden", "not a member of this company");
    return current;
  }

  async #superAdmin(tx: TenancyRecords, actor: Member): Promise<Member> {
    const current = await this.#active(tx, actor);
    if (current.role !== "super_admin") throw new TenancyError("forbidden", "only a super admin may do this");
    return current;
  }

  async #activeMember(tx: TenancyRecords, tenantId: string, memberId: string): Promise<Member> {
    const member = await tx.member(tenantId, memberId);
    if (member?.status !== "active") throw new RangeError(`no member ${memberId}`);
    return member;
  }

  /** Refuse a change that would take the company's last active super admin away. */
  async #keepsSuperAdmin(tx: TenancyRecords, leaving: Member): Promise<void> {
    if (leaving.role !== "super_admin") return;
    const others = (await tx.members(leaving.tenant_id)).filter(
      (m) => m.id !== leaving.id && m.status === "active" && m.role === "super_admin",
    );
    if (others.length === 0) throw new TenancyError("conflict", "the company would have no super admin");
  }

  /** The link's maker, when the link is open: not revoked, not expired, and made by a super admin who still is one. */
  async #open(tx: TenancyRecords, invite: InviteRecord): Promise<Member | undefined> {
    if (invite.revoked_at || invite.expires_at <= this.#now().toISOString()) return undefined;
    const maker = await tx.member(invite.tenant_id, invite.created_by);
    return maker?.status === "active" && maker.role === "super_admin" ? maker : undefined;
  }
}
