// The people of a demo company (people.yaml) as the business backend's browser API shows them:
// each one's session once signed in, and the company's members. The stand-in backend
// (backend.ts) and a snapshot's replay (replay.ts) both answer from here, so the page reads
// either the way it reads the business backend (apps/business).

/** A role in a company. Owners are named on spaces, never as a company role. */
export type ProductRole = "super_admin" | "member";

/** Who is signed in, the companies they belong to, and the one the page acts in. */
export interface Session {
  account: { name: string; email: string; locale: string };
  companies: { tenant_id: string; name: string; role: ProductRole }[];
  /** Absent until the account belongs to a company. */
  current?: { tenant_id: string; member_id: string; display_name: string; role: ProductRole };
}

/** An active member of the current company, as the members list shows them. */
export interface Member {
  member_id: string;
  display_name: string;
  email: string;
  role: ProductRole;
}

/** One person of the demo company, as the business layer's accounts would name them. */
export interface Person {
  member: string;
  name: string;
  /** Their team and role, in the company's own words. */
  about?: string;
  /** The interface language their account has, a BCP 47 tag. */
  locale?: string;
  email?: string;
  role?: ProductRole;
}

export interface People {
  tenant: string;
  people: Person[];
}

/** A change to an account: its name, or its language. */
export interface AccountChange {
  name?: string;
  locale?: string;
}

/** The languages an account may have, as the business backend takes them. */
export const LOCALES = ["en", "zh-CN", "ja"] as const;

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

export function membersOf(people: People): Member[] {
  return people.people.map((p) => ({
    member_id: p.member,
    display_name: p.name,
    email: p.email ?? "",
    role: p.role ?? "member",
  }));
}

/** The change an account body asks for, or a RangeError naming what is wrong with it. */
export function accountChange(body: unknown): AccountChange {
  const { name, locale } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 100)) {
    throw new RangeError("name must be text of 1 to 100 characters");
  }
  if (locale !== undefined && !LOCALES.includes(locale as (typeof LOCALES)[number])) {
    throw new RangeError(`locale must be one of ${LOCALES.join(", ")}`);
  }
  return { ...(typeof name === "string" && { name: name.trim() }), ...(typeof locale === "string" && { locale }) };
}

/** The account locale for an interface language: the business backend says zh-CN for Chinese. */
export const tagLocale = (tag: string): string => (tag === "zh" ? "zh-CN" : tag);
