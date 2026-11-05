// Signed tokens: a round trip, keys from PEM and JWK, and what verification refuses.

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { generateSigningKey, JwtError, publicKeyOf, signingKeyFromPem, signJwt, verifyJwt } from "../src/index.ts";

const key = generateSigningKey("k1");
const keyFor = async (kid: string) => (kid === key.kid ? publicKeyOf(key.jwk) : undefined);

describe("signed tokens", () => {
  test("verify with the key they name and give back header and payload", async () => {
    const token = signJwt({ sub: "mem_01QINGHE0000000000ZHOUMIN", n: 1 }, key);
    expect(await verifyJwt(token, keyFor)).toEqual({
      header: { alg: "EdDSA", typ: "JWT", kid: "k1" },
      payload: { sub: "mem_01QINGHE0000000000ZHOUMIN", n: 1 },
    });
  });

  test("publish only the public half of the key", () => {
    expect(Object.keys(key.jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
  });

  test("sign with a key loaded from PEM", async () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const loaded = signingKeyFromPem(pem, "k2");
    const token = signJwt({ ok: true }, loaded);
    expect((await verifyJwt(token, async () => publicKeyOf(loaded.jwk))).payload).toEqual({ ok: true });
  });

  test("refuse a key that is not Ed25519", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" });
    expect(() => signingKeyFromPem(pem.toString(), "k3")).toThrow(JwtError);
    expect(() => publicKeyOf({ kty: "RSA" })).toThrow(/not an Ed25519 key/);
  });
});

describe("verification refuses", () => {
  const forge = (header: object, payload: object, signer = key.privateKey) => {
    const signed = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    return `${signed}.${sign(null, Buffer.from(signed), signer).toString("base64url")}`;
  };

  test("a signature by another key", async () => {
    const other = generateSigningKey("k1");
    await expect(verifyJwt(signJwt({}, other), keyFor)).rejects.toThrow(/signature/);
  });

  test("another algorithm, or none", async () => {
    await expect(verifyJwt(forge({ alg: "none", kid: "k1" }, {}), keyFor)).rejects.toThrow(/algorithm/);
    await expect(verifyJwt(forge({ alg: "HS256", kid: "k1" }, {}), keyFor)).rejects.toThrow(/algorithm/);
  });

  test("a key it does not know, or no key at all", async () => {
    await expect(verifyJwt(forge({ alg: "EdDSA", kid: "k9" }, {}), keyFor)).rejects.toThrow(/no signing key k9/);
    await expect(verifyJwt(forge({ alg: "EdDSA" }, {}), keyFor)).rejects.toThrow(/names no key/);
  });

  test("anything that is not a compact JWT of JSON objects", async () => {
    await expect(verifyJwt("abc", keyFor)).rejects.toThrow(/not a JWT/);
    await expect(verifyJwt("bm90IGpzb24.e30.c2ln", keyFor)).rejects.toThrow(/header/);
    await expect(verifyJwt(forge({ alg: "EdDSA", kid: "k1" }, [1, 2]), keyFor)).rejects.toThrow(/payload/);
  });
});
