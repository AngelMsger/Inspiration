/** Personal access tokens: the rules, over a GrantStore. */

import { createHash, randomBytes } from "node:crypto";
import { type Scope, ulid } from "@inspiration/contracts";
import type { ProductRole, TokenSpaces } from "@inspiration/contracts/business";
import type { GrantRecord, GrantStore } from "./store.ts";

/** The longest a token lasts. */
export const TOKEN_DAYS = 90;
/** Every secret starts with it, so people and secret scanners know one when they see it. */
export const SECRET_PREFIX = "insp_pat_";
/** What a token may do in the MVP: read. */
const SCOPES: Scope[] = ["knowledge.read"];
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** The member a token is made by or acts for, and their product role. */
export interface Holder {
  tenant_id: string;
  id: string;
  role: ProductRole;
}

export class AccessGrants {
  readonly store: GrantStore;
  readonly #now: () => Date;

  constructor(store: GrantStore, options: { clock?: () => Date } = {}) {
    this.store = store;
    this.#now = options.clock ?? (() => new Date());
  }

  /** A new token for the member. Its secret is returned this once; only its hash is kept. */
  async create(
    member: Holder,
    input: { name: string; spaces: TokenSpaces; days: number },
  ): Promise<{ grant: GrantRecord; secret: string }> {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > TOKEN_DAYS) {
      throw new RangeError(`a token lasts 1 to ${TOKEN_DAYS} days`);
    }
    const secret = `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.#now();
    const grant: GrantRecord = {
      id: `tok_${ulid()}`,
      tenant_id: member.tenant_id,
      member_id: member.id,
      name: input.name,
      spaces: input.spaces,
      scopes: SCOPES,
      secret_hash: hashOf(secret),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.days * DAY).toISOString(),
    };
    await this.store.put(grant);
    return { grant, secret };
  }

  /** The tokens that still work, newest first: the member's own, or with all every member's of the company. */
  async list(member: Holder, options: { all?: boolean } = {}): Promise<GrantRecord[]> {
    const grants = await this.store.of(member.tenant_id, options.all ? undefined : member.id);
    return grants
      .filter((g) => this.#works(g))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  }

  /**
   * Revoke a token at once: the member's own, or any of the company's for a super admin. One
   * the actor may not see raises RangeError, as an unknown one does; revoking twice changes nothing.
   */
  async revoke(actor: Holder, id: string): Promise<void> {
    const grant = await this.store.get(actor.tenant_id, id);
    if (!grant || (grant.member_id !== actor.id && actor.role !== "super_admin")) {
      throw new RangeError(`no token ${id}`);
    }
    if (!grant.revoked_at) await this.store.put({ ...grant, revoked_at: this.#now().toISOString() });
  }

  /** Revoke every token of a member, as when they leave the company. */
  async revokeAll(tenantId: string, memberId: string): Promise<void> {
    const revoked_at = this.#now().toISOString();
    for (const grant of await this.store.of(tenantId, memberId)) {
      if (!grant.revoked_at) await this.store.put({ ...grant, revoked_at });
    }
  }

  /**
   * The token a secret belongs to, while it works: not revoked, not expired. Its last use is
   * kept to the minute, so a client calling often writes once a minute at most.
   */
  async check(secret: string): Promise<GrantRecord | undefined> {
    if (!secret.startsWith(SECRET_PREFIX)) return undefined;
    const grant = await this.store.bySecret(hashOf(secret));
    if (!grant || !this.#works(grant)) return undefined;
    const minute = new Date(Math.floor(this.#now().getTime() / MINUTE) * MINUTE).toISOString();
    if (grant.last_used_at !== minute) {
      grant.last_used_at = minute;
      await this.store.put(grant);
    }
    return grant;
  }

  #works(grant: GrantRecord): boolean {
    return !grant.revoked_at && grant.expires_at > this.#now().toISOString();
  }
}
