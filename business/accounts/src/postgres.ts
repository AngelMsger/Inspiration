/** The accounts records in Postgres, in the accounts schema (migrations/). */

import { type Pool, withTransaction } from "@inspiration/kernel";
import type { AccountsStore, Identity, Session, SignIn, User } from "./store.ts";

const iso = (d: Date) => d.toISOString();

interface UserRow extends Omit<User, "id" | "created_at"> {
  user_id: string;
  created_at: Date;
}

interface SessionRow extends Omit<Session, "tenant_id" | "created_at" | "expires_at"> {
  tenant_id: string | null;
  created_at: Date;
  expires_at: Date;
}

interface SignInRow extends Omit<SignIn, "created_at"> {
  created_at: Date;
}

const INSERT_USER = `INSERT INTO accounts.users (user_id, name, email, locale, created_at) VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, email = excluded.email, locale = excluded.locale`;
const userParams = (u: User) => [u.id, u.name, u.email, u.locale, u.created_at];

export class PostgresAccounts implements AccountsStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async #rows<R>(sql: string, params: unknown[]): Promise<R[]> {
    return (await this.pool.query(sql, params)).rows as R[];
  }

  async user(userId: string) {
    const [r] = await this.#rows<UserRow>("SELECT * FROM accounts.users WHERE user_id = $1", [userId]);
    return r && { id: r.user_id, name: r.name, email: r.email, locale: r.locale, created_at: iso(r.created_at) };
  }

  async putUser(u: User) {
    await this.pool.query(INSERT_USER, userParams(u));
  }

  async identity(provider: string, subject: string) {
    const [r] = await this.#rows<Identity>("SELECT * FROM accounts.identities WHERE provider = $1 AND subject = $2", [
      provider,
      subject,
    ]);
    return r;
  }

  async addUser(u: User, i: Identity) {
    await withTransaction(this.pool, async (client) => {
      await client.query(INSERT_USER, userParams(u));
      await client.query(
        `INSERT INTO accounts.identities (provider, subject, user_id, email, email_verified)
         VALUES ($1, $2, $3, $4, $5)`,
        [i.provider, i.subject, i.user_id, i.email, i.email_verified],
      );
    });
  }

  async session(tokenHash: string) {
    const [r] = await this.#rows<SessionRow>("SELECT * FROM accounts.sessions WHERE token_hash = $1", [tokenHash]);
    return (
      r && {
        token_hash: r.token_hash,
        user_id: r.user_id,
        ...(r.tenant_id && { tenant_id: r.tenant_id }),
        created_at: iso(r.created_at),
        expires_at: iso(r.expires_at),
      }
    );
  }

  async putSession(s: Session) {
    await this.pool.query(
      `INSERT INTO accounts.sessions (token_hash, user_id, tenant_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET tenant_id = excluded.tenant_id, expires_at = excluded.expires_at`,
      [s.token_hash, s.user_id, s.tenant_id ?? null, s.created_at, s.expires_at],
    );
  }

  async deleteSession(tokenHash: string) {
    await this.pool.query("DELETE FROM accounts.sessions WHERE token_hash = $1", [tokenHash]);
  }

  async putSignIn(a: SignIn) {
    await this.pool.query(
      `INSERT INTO accounts.sign_ins (state, nonce, verifier, return_to, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [a.state, a.nonce, a.verifier, a.return_to, a.created_at],
    );
  }

  async takeSignIn(state: string) {
    const [r] = await this.#rows<SignInRow>("DELETE FROM accounts.sign_ins WHERE state = $1 RETURNING *", [state]);
    return r && { ...r, created_at: iso(r.created_at) };
  }
}
