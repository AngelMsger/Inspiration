/**
 * A development token issuer, standing in for the business layer in tests and local runs: it
 * holds an Ed25519 key, publishes its public half as a JWKS and mints principal tokens with the
 * kernel's signJwt, the code the business layer signs with.
 *
 *     const issuer = devIssuer();
 *     const tokens = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys: issuer.keys });
 *     const bearer = issuer.mint({ sub: "mem_…", tid: "ten_…", kind: "member" });
 */

import { randomUUID, sign } from "node:crypto";
import type { PrincipalClaims } from "@inspiration/contracts";
import { generateSigningKey, signJwt } from "@inspiration/kernel";
import { type Jwks, type KeySource, staticKeys } from "./tokens.ts";

export interface DevIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: Jwks;
  readonly keys: KeySource;
  /**
   * A signed token. Claims left out get defaults: the issuer and audience, a member's scopes
   * (the provisioning scope for a service), now as iat, ttlSeconds (300) to exp, a fresh jti.
   * now is in milliseconds, as Date.now(). header forges header fields, for tests of refusals.
   */
  mint(
    claims: Partial<PrincipalClaims> & Pick<PrincipalClaims, "sub" | "tid" | "kind">,
    options?: { ttlSeconds?: number; now?: number; header?: Record<string, unknown> },
  ): string;
}

export function devIssuer(options: { issuer?: string; audience?: string; kid?: string } = {}): DevIssuer {
  const issuer = options.issuer ?? "http://localhost:4200";
  const audience = options.audience ?? "http://localhost:4100";
  const key = generateSigningKey(options.kid ?? "dev-1");
  const jwks: Jwks = { keys: [key.jwk] };
  return {
    issuer,
    audience,
    jwks,
    keys: staticKeys(jwks),
    mint(claims, { ttlSeconds = 300, now = Date.now(), header } = {}) {
      const iat = Math.floor(now / 1000);
      const payload: PrincipalClaims = {
        iss: issuer,
        aud: audience,
        scope: claims.kind === "service" ? "provision.directory" : "knowledge.read knowledge.propose",
        iat,
        exp: iat + ttlSeconds,
        jti: randomUUID(),
        ...claims,
      };
      if (!header) return signJwt({ ...payload }, key);
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const signed = `${b64({ alg: "EdDSA", typ: "JWT", kid: key.kid, ...header })}.${b64(payload)}`;
      return `${signed}.${sign(null, Buffer.from(signed, "ascii"), key.privateKey).toString("base64url")}`;
    },
  };
}
