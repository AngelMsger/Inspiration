/**
 * Principal tokens. The business layer signs a JWT (EdDSA over Ed25519) for every request and
 * publishes its public keys as a JWKS; the engine verifies the token and acts for the principal
 * it names. It is the one verification path for the web app, the CLI and MCP clients.
 *
 *     const tokens = new TokenVerifier({ issuer, audience, keys: jwksFromUrl(`${issuer}/.well-known/jwks.json`) });
 *     const who = await tokens.verify(bearer); // a Principal, or a TokenError
 *
 * A token is valid at most 15 minutes (web tokens 5, OAuth access tokens 10 to 15), with 30
 * seconds of leeway for clocks. Agent tokens are refused until the agent API accepts them.
 */

import type { KeyObject } from "node:crypto";
import { contractErrors, type Principal, type PrincipalClaims, type Scope } from "@inspiration/contracts";
import { JwtError, publicKeyOf, verifyJwt } from "@inspiration/kernel";

/** A token that does not verify. The message says why, for logs; callers answer 401 whatever it says. */
export class TokenError extends Error {
  override name = "TokenError";
}

export interface PublicJwk {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface Jwks {
  readonly keys: readonly PublicJwk[];
}

/** Where the verifier finds the signing keys. refresh is true when a token names a key the last answer lacked. */
export type KeySource = (refresh: boolean) => Promise<Jwks>;

/** Keys known up front, as in tests and development. */
export function staticKeys(jwks: Jwks): KeySource {
  return async () => jwks;
}

/**
 * Keys from a JWKS URL, kept until a token names a key they lack. The URL is fetched again then,
 * at most once every minRefreshMs, so a stream of forged key IDs cannot make the engine hammer it.
 */
export function jwksFromUrl(
  url: string,
  options: { minRefreshMs?: number; fetch?: typeof fetch; now?: () => number } = {},
): KeySource {
  const get = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const minRefreshMs = options.minRefreshMs ?? 30_000;
  let cached: Jwks | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  return async (refresh) => {
    if (cached && (!refresh || now() - fetchedAt < minRefreshMs)) return cached;
    const res = await get(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new TokenError(`the signing keys at ${url} answered ${res.status}`);
    const body = (await res.json()) as Jwks;
    if (!Array.isArray(body?.keys)) throw new TokenError(`the signing keys at ${url} are not a JWKS`);
    cached = body;
    fetchedAt = now();
    return cached;
  };
}

const MAX_LIFETIME_S = 15 * 60;
const LEEWAY_S = 30;
const SCOPES: ReadonlySet<string> = new Set<Scope>([
  "knowledge.read",
  "knowledge.propose",
  "knowledge.write",
  "comments.write",
  "provision.directory",
]);
const PREFIX_OF_KIND: Readonly<Record<string, string>> = { member: "mem_", service: "svc_" };

export class TokenVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly #keys: KeySource;
  readonly #imported = new WeakMap<PublicJwk, KeyObject>();

  constructor(options: { issuer: string; audience: string; keys: KeySource }) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.#keys = options.keys;
  }

  /** The principal a token names, once its signature, issuer, audience, lifetime and claims check out. */
  async verify(token: string, now: number = Date.now()): Promise<Principal> {
    let claims: unknown;
    try {
      claims = (await verifyJwt(token, (kid) => this.#key(kid))).payload;
    } catch (error) {
      throw error instanceof JwtError ? new TokenError(error.message) : error;
    }
    const errors = contractErrors("PrincipalClaims", claims);
    if (errors.length) throw new TokenError(`claims: ${errors.join("; ")}`);
    return this.#principal(claims as PrincipalClaims, Math.floor(now / 1000));
  }

  #principal(claims: PrincipalClaims, nowS: number): Principal {
    if (claims.iss !== this.issuer) throw new TokenError(`issuer ${claims.iss} is not ${this.issuer}`);
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (!audiences.includes(this.audience)) throw new TokenError(`the token is not for ${this.audience}`);
    if (claims.exp <= nowS - LEEWAY_S) throw new TokenError("the token has expired");
    if (claims.iat > nowS + LEEWAY_S) throw new TokenError("the token is issued in the future");
    if (claims.exp - claims.iat > MAX_LIFETIME_S) throw new TokenError(`the token lives over ${MAX_LIFETIME_S} s`);
    const prefix = PREFIX_OF_KIND[claims.kind];
    if (!prefix) throw new TokenError(`a ${claims.kind} token is not accepted`);
    if (!claims.sub.startsWith(prefix)) throw new TokenError(`a ${claims.kind} token names ${claims.sub}`);
    const scopes = claims.scope.split(" ");
    const unknown = scopes.filter((s) => !SCOPES.has(s));
    if (unknown.length) throw new TokenError(`unknown scope ${unknown.join(", ")}`);
    return {
      id: claims.sub,
      kind: claims.kind,
      tenant_id: claims.tid,
      scopes: [...new Set(scopes)].sort() as Scope[],
      ...(claims.locale && { locale: claims.locale }),
      ...(claims.auth && { auth_context: claims.auth }),
    };
  }

  async #key(kid: string): Promise<KeyObject | undefined> {
    const jwk = (await this.#lookup(kid, false)) ?? (await this.#lookup(kid, true));
    if (!jwk) return undefined;
    let key = this.#imported.get(jwk);
    if (!key) {
      key = publicKeyOf(jwk);
      this.#imported.set(jwk, key);
    }
    return key;
  }

  async #lookup(kid: string, refresh: boolean): Promise<PublicJwk | undefined> {
    const jwks = await this.#keys(refresh);
    return jwks.keys.find((k) => k.kid === kid && (k.use === undefined || k.use === "sig"));
  }
}
