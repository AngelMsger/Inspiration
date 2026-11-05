/** Signing in and out, sessions, and the account's own settings. */

import { createHash, randomBytes } from "node:crypto";
import { ulid } from "@inspiration/contracts";
import type { UiLocale } from "@inspiration/contracts/business";
import type { IdentityProvider, Screen } from "./oidc.ts";
import { SignInError } from "./oidc.ts";
import type { AccountsStore, Session, User } from "./store.ts";

/** How long a session lasts after signing in. */
export const SESSION_DAYS = 14;
/** How long a sign-in may take between the redirect and the callback. */
export const SIGN_IN_MINUTES = 10;
const MINUTE = 60 * 1000;

export const UI_LOCALES: readonly UiLocale[] = ["en", "zh-CN", "ja"];

const token = () => randomBytes(32).toString("base64url");
const sha256 = (text: string, encoding: "hex" | "base64url") => createHash("sha256").update(text).digest(encoding);

/**
 * A path on this site to go back to, query included. Anything that would leave the site, such
 * as `//other.host` or `/\\other.host`, becomes `/`: the path is read the way a browser reads it.
 */
export function sitePath(returnTo: string | undefined): string {
  const base = "http://site.invalid";
  const url = returnTo?.startsWith("/") ? URL.parse(returnTo, base) : null;
  return url?.origin === base ? `${url.pathname}${url.search}${url.hash}` : "/";
}

/** The account's language for a new account: the first of the browser's that the product speaks. */
export function localeOf(acceptLanguage: string | undefined): UiLocale {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    if (tag === "ja" || tag.startsWith("ja-")) return "ja";
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

/** A signed-in session and its account. */
export interface SignedIn {
  user: User;
  session: Session;
}

export class Accounts {
  readonly store: AccountsStore;
  readonly provider: IdentityProvider;
  readonly #now: () => Date;

  constructor(store: AccountsStore, provider: IdentityProvider, options: { clock?: () => Date } = {}) {
    this.store = store;
    this.provider = provider;
    this.#now = options.clock ?? (() => new Date());
  }

  /**
   * Start signing in or up: the provider's URL to send the browser to, and the sign-in's state.
   * The caller ties the state to the browser (a cookie) and checks it on the callback, so a
   * callback someone else began, and sent to this browser, does not sign it in.
   */
  async startSignIn(input: {
    returnTo?: string;
    screen: Screen;
    locale?: UiLocale;
  }): Promise<{ url: string; state: string }> {
    const verifier = token();
    const signIn = {
      state: token(),
      nonce: token(),
      verifier,
      return_to: sitePath(input.returnTo),
      created_at: this.#now().toISOString(),
    };
    await this.store.putSignIn(signIn);
    const url = await this.provider.signInUrl({
      state: signIn.state,
      nonce: signIn.nonce,
      challenge: sha256(verifier, "base64url"),
      screen: input.screen,
      ...(input.locale && { locale: input.locale }),
    });
    return { url, state: signIn.state };
  }

  /**
   * Finish a sign-in from the provider's callback. A person signing in for the first time gets
   * an account, named as the provider names them, in the language given. Answers the new
   * session's token, for the cookie, and where to go back to.
   */
  async finishSignIn(input: { state: string; code: string; locale: UiLocale }): Promise<{
    token: string;
    returnTo: string;
    user: User;
  }> {
    const signIn = await this.store.takeSignIn(input.state);
    const now = this.#now();
    if (!signIn || Date.parse(signIn.created_at) + SIGN_IN_MINUTES * MINUTE < now.getTime()) {
      throw new SignInError("this sign-in has expired or was already used");
    }
    const who = await this.provider.finish(input.code, signIn.verifier, signIn.nonce);
    const user = await this.#userOf(who, input.locale, now);
    const secret = token();
    await this.store.putSession({
      token_hash: sha256(secret, "hex"),
      user_id: user.id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_DAYS * 24 * 60 * MINUTE).toISOString(),
    });
    return { token: secret, returnTo: signIn.return_to, user };
  }

  /** The session a cookie's token names, while it lasts. */
  async session(secret: string | undefined): Promise<SignedIn | undefined> {
    if (!secret) return undefined;
    const session = await this.store.session(sha256(secret, "hex"));
    if (!session || session.expires_at <= this.#now().toISOString()) return undefined;
    const user = await this.store.user(session.user_id);
    return user && { user, session };
  }

  /** Make a company the one the session works in, or none. The caller checks the account belongs to it. */
  async workIn(session: Session, tenantId: string | undefined): Promise<Session> {
    const { tenant_id: _, ...rest } = session;
    const next = { ...rest, ...(tenantId && { tenant_id: tenantId }) };
    await this.store.putSession(next);
    return next;
  }

  /** Change the account's name or language. */
  async update(user: User, change: { name?: string; locale?: UiLocale }): Promise<User> {
    const next = { ...user, ...change };
    await this.store.putUser(next);
    return next;
  }

  /** End the session; answers the provider's own sign-out, for the browser to open next. */
  async signOut(session: Session | undefined): Promise<string> {
    if (session) await this.store.deleteSession(session.token_hash);
    return this.provider.signOutUrl();
  }

  async #userOf(
    who: { subject: string; email?: string; email_verified: boolean; name?: string },
    locale: UiLocale,
    now: Date,
  ): Promise<User> {
    const known = await this.store.identity(this.provider.name, who.subject);
    if (known) {
      const user = await this.store.user(known.user_id);
      if (user) return user;
    }
    if (!who.email) throw new SignInError("an email address is needed to sign in");
    const user: User = {
      id: `usr_${ulid()}`,
      name: who.name ?? who.email.split("@")[0] ?? who.email,
      email: who.email,
      locale,
      created_at: now.toISOString(),
    };
    const identity = {
      provider: this.provider.name,
      subject: who.subject,
      user_id: user.id,
      email: who.email,
      email_verified: who.email_verified,
    };
    try {
      await this.store.addUser(user, identity);
      return user;
    } catch (e) {
      // The same person finished two first sign-ins at once: the other one made the account.
      const other = await this.store.identity(this.provider.name, who.subject);
      const existing = other && (await this.store.user(other.user_id));
      if (existing) return existing;
      throw e;
    }
  }
}
