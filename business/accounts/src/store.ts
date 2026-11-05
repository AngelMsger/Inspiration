/** The accounts records and where they are kept: in memory for tests, in Postgres (postgres.ts). */

import type { UiLocale } from "@inspiration/contracts/business";

/** The account: one per person, whatever companies they belong to. */
export interface User {
  /** usr_: never sent to the engine. */
  id: string;
  name: string;
  email: string;
  locale: UiLocale;
  created_at: string;
}

/** How a person signs in: their ID at an identity provider. */
export interface Identity {
  provider: string;
  subject: string;
  user_id: string;
  email: string;
  email_verified: boolean;
}

export interface Session {
  /** The hash of the cookie's token; the token itself is never kept. */
  token_hash: string;
  user_id: string;
  /** The company the person works in now. */
  tenant_id?: string;
  created_at: string;
  expires_at: string;
}

/** A sign-in between the redirect to the provider and its callback. */
export interface SignIn {
  state: string;
  nonce: string;
  /** The PKCE code verifier. */
  verifier: string;
  return_to: string;
  created_at: string;
}

export interface AccountsStore {
  user(userId: string): Promise<User | undefined>;
  putUser(user: User): Promise<void>;
  identity(provider: string, subject: string): Promise<Identity | undefined>;
  /** Keep a new user with the identity they first signed in with, both or neither. */
  addUser(user: User, identity: Identity): Promise<void>;
  session(tokenHash: string): Promise<Session | undefined>;
  putSession(session: Session): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  putSignIn(signIn: SignIn): Promise<void>;
  /** The sign-in with this state, removed so it is used at most once. */
  takeSignIn(state: string): Promise<SignIn | undefined>;
}

const copy = structuredClone;

export class MemoryAccounts implements AccountsStore {
  readonly #users = new Map<string, User>();
  readonly #identities = new Map<string, Identity>();
  readonly #sessions = new Map<string, Session>();
  readonly #signIns = new Map<string, SignIn>();

  async user(userId: string) {
    return copy(this.#users.get(userId));
  }

  async putUser(user: User) {
    this.#users.set(user.id, copy(user));
  }

  async identity(provider: string, subject: string) {
    return copy(this.#identities.get(`${provider}|${subject}`));
  }

  async addUser(user: User, identity: Identity) {
    const key = `${identity.provider}|${identity.subject}`;
    if (this.#identities.has(key)) throw new RangeError(`identity ${key} already has a user`);
    this.#users.set(user.id, copy(user));
    this.#identities.set(key, copy(identity));
  }

  async session(tokenHash: string) {
    return copy(this.#sessions.get(tokenHash));
  }

  async putSession(session: Session) {
    this.#sessions.set(session.token_hash, copy(session));
  }

  async deleteSession(tokenHash: string) {
    this.#sessions.delete(tokenHash);
  }

  async putSignIn(signIn: SignIn) {
    this.#signIns.set(signIn.state, copy(signIn));
  }

  async takeSignIn(state: string) {
    const signIn = this.#signIns.get(state);
    this.#signIns.delete(state);
    return signIn;
  }
}
