// The people of a demo company (people.yaml) as the business backend's browser API shows them:
// each one's session once signed in, and the company's members, in the business contracts
// (@inspiration/contracts/business). The stand-in backend (backend.ts) and a snapshot's replay
// (replay.ts) both answer from here, so the page reads either the way it reads the business
// backend (apps/business).

import type { AccountChange, CompanyMember, ProductRole, Session, UiLocale } from "@inspiration/contracts/business";

/** One person of the demo company, as the business layer's accounts would name them. */
export interface Person {
  member: string;
  name: string;
  /** Their team and role, in the company's own words. */
  about?: string;
  /** The interface language their account has. */
  locale?: UiLocale;
  email?: string;
  role?: ProductRole;
}

export interface People {
  tenant: string;
  people: Person[];
}

/** The languages an account may have: the contracts' UiLocale, which a test holds this to. */
export const LOCALES: readonly UiLocale[] = ["en", "zh-CN", "ja"];

/** A person's session in the demo company, named `company`, with the changes made to their account. */
export function sessionOf(people: People, person: Person, company: string, change: AccountChange = {}): Session {
  const name = change.name ?? person.name;
  const role = person.role ?? "member";
  return {
    account: { name, email: person.email ?? "", locale: change.locale ?? person.locale ?? "en" },
    companies: [{ tenant_id: people.tenant, name: company, role }],
    current: { tenant_id: people.tenant, member_id: person.member, display_name: name, role },
  };
}

export function membersOf(people: People): CompanyMember[] {
  return people.people.map((p) => ({
    member_id: p.member,
    display_name: p.name,
    email: p.email ?? "",
    role: p.role ?? "member",
  }));
}

/** The account locale for an interface language: the business backend says zh-CN for Chinese. */
export const tagLocale = (tag: string): UiLocale => (tag === "zh" ? "zh-CN" : (tag as UiLocale));
