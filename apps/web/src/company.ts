// A demo company as its people and its super admins change it: roles, members who leave, invite
// links and joining by one. The stand-in backend (backend.ts) and a snapshot's replay (replay.ts)
// each keep one for as long as they run, so the members and invite screens work the same over
// either; the business backend (apps/business) keeps the real thing, with the same rules: a
// company always keeps a super admin, a link joins anyone who opens it signed in for 7 days
// unless it is revoked or its maker stops being a super admin, and joining twice keeps the
// membership.

import type {
  AccountChange,
  CompanyMember,
  Invite,
  InviteLink,
  InviteList,
  JoinPreview,
  ProductRole,
  Session,
} from "@inspiration/contracts/business";
import type { People, Person } from "./people.ts";

/** A request the browser API refuses, with the status and code it answers. */
export class Refused extends Error {
  override name = "Refused";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Letters and digits, as the contracts' IDs take them. */
const randomId = () => crypto.randomUUID().replaceAll("-", "");

export class Company {
  readonly people: People;
  readonly #kept: ReadonlySet<string>;
  readonly #roles = new Map<string, ProductRole>();
  readonly #left = new Set<string>();
  readonly #links: { invite: Invite; code: string; revoked: boolean }[] = [];

  /** `kept` are members who may not be removed, as the people a snapshot's script acts as. */
  constructor(people: People, kept: Iterable<string> = []) {
    this.people = people;
    this.#kept = new Set(kept);
  }

  roleOf(person: Person): ProductRole {
    return this.#roles.get(person.member) ?? person.role ?? "member";
  }

  isMember(person: Person): boolean {
    return !this.#left.has(person.member);
  }

  /** The active members, as GET /api/members lists them. */
  members(): CompanyMember[] {
    return this.people.people.filter((p) => this.isMember(p)).map((p) => this.#entry(p));
  }

  /** A person's session, in the company named `name`; with no company once they left it. */
  sessionOf(person: Person, name: string, change: AccountChange = {}): Session {
    const display = change.name ?? person.name;
    const account = { name: display, email: person.email ?? "", locale: change.locale ?? person.locale ?? "en" };
    if (!this.isMember(person)) return { account, companies: [] };
    const role = this.roleOf(person);
    return {
      account,
      companies: [{ tenant_id: this.people.tenant, name, role }],
      current: { tenant_id: this.people.tenant, member_id: person.member, display_name: display, role },
    };
  }

  setRole(by: Person, member: string, role: ProductRole): CompanyMember {
    this.#admin(by);
    const person = this.#member(member);
    if (role === "member") this.#keepASuperAdmin(person);
    this.#roles.set(person.member, role);
    return this.#entry(person);
  }

  remove(by: Person, member: string): void {
    this.#admin(by);
    const person = this.#member(member);
    // A demo-only code, as not_recorded is: the page says it in the reader's language.
    if (this.#kept.has(person.member)) throw new Refused(409, "demo_script", "the demo's script needs this person");
    this.#keepASuperAdmin(person);
    this.#left.add(person.member);
  }

  /** A new link, shown this once; `url` gives a code's address on the site. */
  invite(by: Person, url: (code: string) => string, now = new Date()): InviteLink {
    this.#admin(by);
    const invite: Invite = {
      id: `inv_${randomId()}`,
      created_by: { member_id: by.member, display_name: by.name },
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + WEEK).toISOString(),
      joined: 0,
    };
    const code = randomId();
    this.#links.push({ invite, code, revoked: false });
    return { invite, url: url(code) };
  }

  /** The links still open, newest first. */
  invites(by: Person, now = new Date()): InviteList {
    this.#admin(by);
    const open = this.#links.filter((l) => this.#isOpen(l, now)).map((l) => l.invite);
    return { invites: open.reverse() };
  }

  revoke(by: Person, id: string): void {
    this.#admin(by);
    const link = this.#links.find((l) => l.invite.id === id && !l.revoked);
    if (!link) throw new RangeError(`no open invite link ${id}`);
    link.revoked = true;
  }

  /** What a link would join, for anyone holding it; unknown, expired and revoked codes alike are not found. */
  preview(code: string, name: string, now = new Date()): JoinPreview {
    const { invite } = this.#link(code, now);
    return {
      company: { name },
      invited_by: { display_name: invite.created_by.display_name },
      expires_at: invite.expires_at,
    };
  }

  /** Joins by a link; someone already a member stays as they are, someone who left comes back as a member. */
  join(person: Person, code: string, now = new Date()): void {
    const link = this.#link(code, now);
    if (this.isMember(person)) return;
    this.#left.delete(person.member);
    this.#roles.set(person.member, "member");
    link.invite.joined += 1;
  }

  #entry(p: Person): CompanyMember {
    return { member_id: p.member, display_name: p.name, email: p.email ?? "", role: this.roleOf(p) };
  }

  #admin(by: Person): void {
    if (!this.isMember(by) || this.roleOf(by) !== "super_admin") {
      throw new Refused(403, "forbidden", "only a super admin of the company can do this");
    }
  }

  #member(member: string): Person {
    const person = this.people.people.find((p) => p.member === member && this.isMember(p));
    if (!person) throw new RangeError(`no member ${member} in this company`);
    return person;
  }

  #keepASuperAdmin(person: Person): void {
    const admins = this.people.people.filter((p) => this.isMember(p) && this.roleOf(p) === "super_admin");
    if (admins.length === 1 && admins[0] === person) {
      throw new Refused(409, "conflict", "the company needs at least one super admin");
    }
  }

  #isOpen(link: { invite: Invite; revoked: boolean }, now: Date): boolean {
    const maker = this.people.people.find((p) => p.member === link.invite.created_by.member_id);
    const makerAdmin = maker !== undefined && this.isMember(maker) && this.roleOf(maker) === "super_admin";
    return !link.revoked && makerAdmin && new Date(link.invite.expires_at) > now;
  }

  #link(code: string, now: Date) {
    const link = this.#links.find((l) => l.code === code);
    if (!link || !this.#isOpen(link, now)) throw new RangeError("no open invite link with this code");
    return link;
  }
}
