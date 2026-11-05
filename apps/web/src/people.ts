// The people of a demo company (people.yaml), as the business layer's accounts would name them,
// and the languages an account may have. The stand-in backend (backend.ts) and a snapshot's
// replay (replay.ts) answer the browser API for them through a Company (company.ts).

import type { ProductRole, UiLocale } from "@inspiration/contracts/business";

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

/** The account locale for an interface language: the business backend says zh-CN for Chinese. */
export const tagLocale = (tag: string): UiLocale => (tag === "zh" ? "zh-CN" : (tag as UiLocale));
