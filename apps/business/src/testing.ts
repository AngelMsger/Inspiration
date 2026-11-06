/**
 * Browsers on the business backend's site, for tests that drive it as people do:
 * @inspiration/business/testing.
 *
 * A Browser is one tab: it keeps its browser's cookies, never follows a redirect, and its page
 * shows the company the last session it read works in, as the web app's frame does, naming it
 * on every call (COMPANY_HEADER) unless the call's own headers say otherwise. Tabs of one
 * browser share its cookies, so a switch in one moves the session under all of them, while
 * each page still shows what it last read.
 *
 *     const zhou = await signIn(siteUrl, provider, ZHOU);   // through the provider's redirect
 *     const other = zhou.tab();                             // a second tab, same session
 */

import type { ProviderIdentity } from "@inspiration/accounts";
import type { FakeProvider } from "@inspiration/accounts/testing";
import type { Session } from "@inspiration/contracts/business";
import { COMPANY_HEADER, SESSION_COOKIE } from "./routes.ts";

/** An answer as a test reads it: its body as the T the test names. */
export interface Answer<T> {
  status: number;
  body: T;
  headers: Headers;
}

export class Browser {
  readonly base: string;
  readonly cookies: Map<string, string>;
  /** The company the page shows. */
  company: string | undefined;

  constructor(base: string, cookies = new Map<string, string>()) {
    this.base = base;
    this.cookies = cookies;
  }

  /** Another tab of the same browser: the same cookies, and a page that shows what this one shows until it reads anew. */
  tab(): Browser {
    const tab = new Browser(this.base, this.cookies);
    tab.company = this.company;
    return tab;
  }

  /** The session cookie's value, while signed in. */
  get session(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }

  /** The cookies, as the browser sends them. */
  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** A call to the site, its body sent as JSON, or as it is when bytes. */
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer<T>> {
    const bytes = body instanceof Uint8Array;
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookies.size && { cookie: this.cookieHeader }),
        ...(this.company && { [COMPANY_HEADER]: this.company }),
        ...(body !== undefined && !bytes && { "content-type": "application/json" }),
        ...headers,
      },
      ...(body !== undefined && { body: bytes ? body : JSON.stringify(body) }),
    });
    this.keep(res.headers.getSetCookie());
    const text = await res.text();
    const json: unknown = res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text;
    if (res.ok && isSession(json)) this.company = json.current?.tenant_id;
    return { status: res.status, body: json as T, headers: res.headers };
  }

  /** Keep the cookies an answer sets, and drop those it expires. */
  keep(setCookies: string[]): void {
    for (const set of setCookies) {
      const [name = "", value = ""] = (set.split(";")[0] ?? "").split("=");
      if (/Max-Age=0(;|$)/.test(set)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

const isSession = (body: unknown): body is Session =>
  typeof body === "object" && body !== null && "account" in body && "companies" in body;

/** A browser signed in as who on the site at base, through the provider's redirect and back. */
export async function signIn(base: string, provider: FakeProvider, who: ProviderIdentity): Promise<Browser> {
  const browser = new Browser(base);
  await browser.call("GET", "/api/auth/sign-in");
  const { code, state } = provider.code(who);
  const back = await browser.call("GET", `/api/auth/callback?${new URLSearchParams({ code, state })}`);
  if (back.status !== 302 || !browser.session) throw new Error(`sign-in failed: ${back.headers.get("location")}`);
  return browser;
}
