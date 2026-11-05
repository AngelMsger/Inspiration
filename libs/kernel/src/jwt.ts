/**
 * Signed tokens: compact JWTs signed with EdDSA over Ed25519, on node:crypto. Both layers use
 * this one implementation: the business layer signs principal tokens with signJwt and publishes
 * the public half of its keys as a JWKS; the engine checks a token with verifyJwt, and access
 * control's TokenVerifier adds the rules for the claims.
 *
 *     const key = signingKeyFromPem(process.env.SIGNING_KEY, "2026-11");   // or generateSigningKey("dev-1")
 *     const token = signJwt({ sub, tid, ... }, key);
 *     const jwks = { keys: [key.jwk] };                                    // served at /.well-known/jwks.json
 *     const { payload } = await verifyJwt(token, async (kid) => kid === key.kid ? publicKeyOf(key.jwk) : undefined);
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";

/** A token that is malformed, uses another algorithm, names an unknown key or fails its signature. */
export class JwtError extends Error {
  override name = "JwtError";
}

/** The public half of a signing key, as a JWKS lists it. */
export interface Ed25519Jwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly kid: string;
  readonly alg: "EdDSA";
  readonly use: "sig";
}

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  /** The public half, to publish. */
  readonly jwk: Ed25519Jwk;
}

export interface DecodedJwt {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A new Ed25519 key pair, for development and tests; a deployment loads its key with signingKeyFromPem. */
export function generateSigningKey(kid: string): SigningKey {
  return signingKey(generateKeyPairSync("ed25519").privateKey, kid);
}

/** A signing key from an Ed25519 private key in PKCS #8 PEM, as `openssl genpkey -algorithm ed25519` writes it. */
export function signingKeyFromPem(pem: string, kid: string): SigningKey {
  return signingKey(createPrivateKey(pem), kid);
}

function signingKey(privateKey: KeyObject, kid: string): SigningKey {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new JwtError("the signing key is not an Ed25519 key");
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof x !== "string") throw new JwtError("the signing key has no public half");
  return { kid, privateKey, jwk: { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" } };
}

/** A public key from a JWK, which must be an Ed25519 key. */
export function publicKeyOf(jwk: { readonly kty?: unknown; readonly crv?: unknown; readonly x?: unknown }): KeyObject {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new JwtError("the key is not an Ed25519 key");
  }
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
}

/** The payload as a compact JWT: header {alg: EdDSA, typ: JWT, kid}, signed with the key. */
export function signJwt(payload: Readonly<Record<string, unknown>>, key: SigningKey): string {
  const signed = `${encode({ alg: "EdDSA", typ: "JWT", kid: key.kid })}.${encode(payload)}`;
  return `${signed}.${sign(null, Buffer.from(signed, "ascii"), key.privateKey).toString("base64url")}`;
}

/**
 * The header and payload of a token whose EdDSA signature verifies with the key its kid names.
 * keyFor answers undefined for a key it does not know. Claims are not checked here.
 */
export async function verifyJwt(
  token: string,
  keyFor: (kid: string) => Promise<KeyObject | undefined>,
): Promise<DecodedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("not a JWT");
  const [head, body, signature] = parts as [string, string, string];
  const header = decode(head, "header");
  if (header.alg !== "EdDSA") throw new JwtError(`algorithm ${JSON.stringify(header.alg)} is not EdDSA`);
  if (typeof header.kid !== "string") throw new JwtError("the header names no key");
  const key = await keyFor(header.kid);
  if (!key) throw new JwtError(`no signing key ${header.kid}`);
  if (!verify(null, Buffer.from(`${head}.${body}`, "ascii"), key, Buffer.from(signature, "base64url"))) {
    throw new JwtError("the signature does not verify");
  }
  return { header, payload: decode(body, "payload") };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(part: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new JwtError(`the ${what} is not a JSON object`);
}
