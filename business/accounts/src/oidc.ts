/**
 * Sign-in through an OpenID Connect provider (Logto in the MVP): the authorization code flow
 * with PKCE for a confidential client, and a check of the ID token it answers with.
 */

import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";

/** What the provider says about the person who signed in. */
export interface ProviderIdentity {
  subject: string;
  email?: string;
  email_verified: boolean;
  name?: string;
}

/** Where a sign-in starts. */
export type Screen = "sign_in" | "sign_up";

export interface SignInRequest {
  state: string;
  nonce: string;
  /** The PKCE code challenge (S256). */
  challenge: string;
  screen: Screen;
  /** The language of the provider's pages: the account's, or the browser's for a new one. */
  locale?: string;
}

/** An identity provider the accounts component signs people in with. */
export interface IdentityProvider {
  /** The provider's name, kept with each identity. */
  readonly name: string;
  signInUrl(request: SignInRequest): Promise<string>;
  /** Exchange the callback's code, and answer who signed in, once the ID token checks out. */
  finish(code: string, verifier: string, nonce: string): Promise<ProviderIdentity>;
  /** The provider's own sign-out, so its session ends too. */
  signOutUrl(): Promise<string>;
}

/** A sign-in the provider or its answer did not let through. */
export class SignInError extends Error {
  override name = "SignInError";
}

export interface OidcOptions {
  /** The issuer, for Logto `https://<host>/oidc`; its discovery document is read from there. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The backend's callback, registered with the provider. */
  redirectUri: string;
  /** Where the provider sends the browser after signing out, also registered. */
  signedOutUri: string;
  /** Seconds of clock difference allowed when checking the ID token's times. */
  leeway?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

/** How each signature algorithm verifies, and the key type it needs. */
const ALGORITHMS: Record<string, { kty: string; hash: string | null; p1363?: boolean }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  ES256: { kty: "EC", hash: "sha256", p1363: true },
  ES384: { kty: "EC", hash: "sha384", p1363: true },
  ES512: { kty: "EC", hash: "sha512", p1363: true },
  EdDSA: { kty: "OKP", hash: null },
};

const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export class OidcProvider implements IdentityProvider {
  readonly name = "logto";
  readonly #options: OidcOptions;
  readonly #fetch: typeof fetch;
  #discovery?: Promise<Discovery>;
  #keys = new Map<string, JsonWebKey>();

  constructor(options: OidcOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async signInUrl(request: SignInRequest): Promise<string> {
    const url = new URL((await this.#discover()).authorization_endpoint);
    const params: Record<string, string> = {
      client_id: this.#options.clientId,
      redirect_uri: this.#options.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.challenge,
      code_challenge_method: "S256",
      // Logto opens its registration screen for first_screen=register.
      ...(request.screen === "sign_up" && { first_screen: "register" }),
      ...(request.locale && { ui_locales: request.locale }),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async finish(code: string, verifier: string, nonce: string): Promise<ProviderIdentity> {
    const discovery = await this.#discover();
    const { clientId, clientSecret, redirectUri } = this.#options;
    const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
    const response = await this.#fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw new SignInError(`the provider refused the code (${response.status})`);
    const { id_token: idToken } = (await response.json()) as { id_token?: unknown };
    if (typeof idToken !== "string") throw new SignInError("the provider answered without an ID token");
    const claims = await this.#verified(idToken, discovery);
    if (claims.nonce !== nonce) throw new SignInError("the ID token is for another sign-in");
    if (typeof claims.sub !== "string" || !claims.sub) throw new SignInError("the ID token names nobody");
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const email = text(claims.email);
    const name = text(claims.name) ?? text(claims.username);
    return {
      subject: claims.sub,
      ...(email && { email }),
      email_verified: claims.email_verified === true,
      ...(name && { name }),
    };
  }

  async signOutUrl(): Promise<string> {
    const { end_session_endpoint: end } = await this.#discover();
    if (!end) return this.#options.signedOutUri;
    const url = new URL(end);
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("post_logout_redirect_uri", this.#options.signedOutUri);
    return url.toString();
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const issuer = this.#options.issuer.replace(/\/$/, "");
      const response = await this.#fetch(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new SignInError(`no discovery document at ${issuer} (${response.status})`);
      const doc = (await response.json()) as Discovery;
      if (doc.issuer !== issuer) throw new SignInError(`the discovery document names issuer ${doc.issuer}`);
      return doc;
    })().catch((e: unknown) => {
      this.#discovery = undefined;
      throw e;
    });
    return this.#discovery;
  }

  /** The token's claims, once its signature, issuer, audience and times check out. */
  async #verified(token: string, discovery: Discovery): Promise<Record<string, unknown>> {
    const [head, body, signature, ...rest] = token.split(".");
    if (!head || !body || !signature || rest.length) throw new SignInError("the ID token is not a JWT");
    const header = json(head);
    const algorithm = ALGORITHMS[String(header.alg)];
    if (!algorithm) throw new SignInError(`the ID token is signed with ${String(header.alg)}`);
    const jwk = await this.#key(String(header.kid ?? ""), discovery);
    if (jwk.kty !== algorithm.kty) throw new SignInError("the ID token's key does not fit its algorithm");
    const key: KeyObject = createPublicKey({ key: jwk, format: "jwk" });
    const ok = verify(
      algorithm.hash,
      Buffer.from(`${head}.${body}`),
      algorithm.p1363 ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(signature, "base64url"),
    );
    if (!ok) throw new SignInError("the ID token's signature does not verify");

    const claims = json(body);
    const now = (this.#options.now?.() ?? new Date()).getTime() / 1000;
    const leeway = this.#options.leeway ?? 60;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== discovery.issuer) throw new SignInError("the ID token is from another issuer");
    if (!audience.includes(this.#options.clientId)) throw new SignInError("the ID token is for another client");
    if (typeof claims.exp !== "number" || claims.exp + leeway < now) throw new SignInError("the ID token has expired");
    if (typeof claims.iat === "number" && claims.iat - leeway > now)
      throw new SignInError("the ID token is not valid yet");
    return claims;
  }

  /** The provider's signing key by ID, read again once when the provider has rotated its keys. */
  async #key(kid: string, discovery: Discovery): Promise<JsonWebKey> {
    if (!this.#keys.has(kid)) {
      const response = await this.#fetch(discovery.jwks_uri);
      if (!response.ok) throw new SignInError(`the provider's keys did not load (${response.status})`);
      const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
      this.#keys = new Map(keys.map((k) => [k.kid ?? "", k]));
    }
    const key = this.#keys.get(kid);
    if (!key) throw new SignInError(`the provider has no key ${kid}`);
    return key;
  }
}
