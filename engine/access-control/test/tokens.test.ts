// Principal tokens: what verifies, what is refused and why, and how keys are fetched.

import { describe, expect, test } from "vitest";
import { type Jwks, jwksFromUrl, staticKeys, TokenError, TokenVerifier } from "../src/index.ts";
import { devIssuer } from "../src/testing.ts";

const TENANT = "ten_01QINGHE000000000000000001";
const MEMBER = "mem_01QINGHE0000000000ZHOUMIN";
const NOW = Date.parse("2026-11-05T03:00:00Z");

const issuer = devIssuer();
const verifier = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys: issuer.keys });
const member = (claims: Record<string, unknown> = {}, options: { ttlSeconds?: number; now?: number } = {}) =>
  issuer.mint({ sub: MEMBER, tid: TENANT, kind: "member", ...claims }, { now: NOW, ...options });

async function refusal(token: string, now = NOW): Promise<string> {
  const error = await verifier.verify(token, now).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TokenError);
  return (error as Error).message;
}

describe("a principal token", () => {
  test("names a member of a tenant, with its scopes, locale and sign-in context", async () => {
    const token = member({ locale: "zh-CN", auth: { method: "password", mfa: false, at: "2026-11-05T02:58:00Z" } });
    expect(await verifier.verify(token, NOW)).toEqual({
      id: MEMBER,
      kind: "member",
      tenant_id: TENANT,
      scopes: ["knowledge.propose", "knowledge.read"],
      locale: "zh-CN",
      auth_context: { method: "password", mfa: false, at: "2026-11-05T02:58:00Z" },
    });
  });

  test("names the tenancy service with the provisioning scope", async () => {
    const token = issuer.mint({ sub: "svc_01TENANCY0000000000000000", tid: TENANT, kind: "service" }, { now: NOW });
    expect(await verifier.verify(token, NOW)).toMatchObject({
      id: "svc_01TENANCY0000000000000000",
      scopes: ["provision.directory"],
    });
  });

  test("narrows what its holder may read with max_sens", async () => {
    expect(await verifier.verify(member({ max_sens: "public" }), NOW)).toMatchObject({
      id: MEMBER,
      max_sensitivity: "public",
    });
    expect(await verifier.verify(member(), NOW)).not.toHaveProperty("max_sensitivity");
  });

  test("may list several audiences", async () => {
    expect(await verifier.verify(member({ aud: ["https://other.example", issuer.audience] }), NOW)).toMatchObject({
      id: MEMBER,
    });
  });

  test("holds 30 seconds past its expiry, for clocks", async () => {
    const token = member({}, { ttlSeconds: 300 });
    expect(await verifier.verify(token, NOW + 320_000)).toMatchObject({ id: MEMBER });
    expect(await refusal(token, NOW + 331_000)).toMatch(/expired/);
  });
});

describe("a token is refused when", () => {
  test("another key signed it", async () => {
    const forger = devIssuer({ issuer: issuer.issuer, audience: issuer.audience });
    const token = forger.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { now: NOW });
    expect(await refusal(token)).toMatch(/signature/);
  });

  test("its payload was changed after signing", async () => {
    const [head, , signature] = member().split(".");
    const body = Buffer.from(JSON.stringify({ sub: "mem_01QINGHE00000000000OTHER", tid: TENANT })).toString(
      "base64url",
    );
    expect(await refusal(`${head}.${body}.${signature}`)).toMatch(/signature/);
  });

  test("its algorithm is not EdDSA", async () => {
    expect(
      await refusal(issuer.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { header: { alg: "none" } })),
    ).toMatch(/algorithm/);
    expect(
      await refusal(issuer.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { header: { alg: "HS256" } })),
    ).toMatch(/algorithm/);
  });

  test("it names a key the issuer does not publish", async () => {
    expect(
      await refusal(issuer.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { header: { kid: "gone" } })),
    ).toMatch(/no signing key gone/);
  });

  test("another issuer or audience is named", async () => {
    expect(await refusal(member({ iss: "https://evil.example" }))).toMatch(/issuer/);
    expect(await refusal(member({ aud: "https://other.example" }))).toMatch(/not for/);
  });

  test("it is issued in the future or lives over 15 minutes", async () => {
    expect(await refusal(member({}, { now: NOW + 120_000 }))).toMatch(/future/);
    expect(await refusal(member({}, { ttlSeconds: 16 * 60 }))).toMatch(/over 900 s/);
  });

  test("its subject does not match its kind, or the kind is not accepted", async () => {
    expect(await refusal(member({ sub: "svc_01TENANCY0000000000000000" }))).toMatch(/member token names svc_01TENANCY/);
    expect(await refusal(member({ sub: "usr_01QINGHE0000000000ZHOUMIN" }))).toMatch(/claims|names/);
    expect(await refusal(member({ kind: "agent", sub: "agt_01QINGHE000000000000HELPER", obo: MEMBER }))).toMatch(
      /agent token is not accepted/,
    );
    expect(await refusal(member({ kind: "group", sub: "grp_01QINGHE0000000000FINANCE" }))).toMatch(/not accepted/);
  });

  test("it carries a claim for agents, which no other token may carry", async () => {
    expect(await refusal(member({ obo: "mem_01QINGHE00000000000000LINA" }))).toMatch(/member token carries obo/);
    const service = issuer.mint(
      {
        sub: "svc_01TENANCY0000000000000000",
        tid: TENANT,
        kind: "service",
        spaces: ["spc_01FINANCE00000000000000000"],
        grant: "g1",
      },
      { now: NOW },
    );
    expect(await refusal(service)).toMatch(/service token carries spaces, grant/);
  });

  test("it carries an unknown scope or misses a required claim", async () => {
    expect(await refusal(member({ scope: "knowledge.read root" }))).toMatch(/unknown scope root/);
    expect(await refusal(member({ tid: undefined }))).toMatch(/claims/);
  });

  test("it is not a JWT at all", async () => {
    expect(await refusal("not-a-token")).toMatch(/not a JWT/);
    expect(await refusal("e30.bm90IGpzb24.c2ln")).toMatch(/algorithm/);
    expect(await refusal("bm90IGpzb24.e30.c2ln")).toMatch(/header/);
  });
});

describe("signing keys", () => {
  test("are fetched again when a token names a new key, then kept", async () => {
    const next = devIssuer({ issuer: issuer.issuer, audience: issuer.audience, kid: "dev-2" });
    let published = issuer.jwks;
    const calls: string[] = [];
    const keys = jwksFromUrl("https://app.example/.well-known/jwks.json", {
      minRefreshMs: 0,
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(published));
      },
    });
    const rotating = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys });
    await rotating.verify(member(), NOW);
    await rotating.verify(member(), NOW);
    expect(calls).toHaveLength(1);
    published = { keys: [...issuer.jwks.keys, ...next.jwks.keys] };
    const rotated = next.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { now: NOW });
    expect(await rotating.verify(rotated, NOW)).toMatchObject({ id: MEMBER });
    expect(calls).toHaveLength(2);
  });

  test("are not fetched again more often than the refresh interval", async () => {
    let calls = 0;
    let clock = 0;
    const keys = jwksFromUrl("https://app.example/jwks", {
      minRefreshMs: 30_000,
      now: () => clock,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify(issuer.jwks));
      },
    });
    const guarded = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys });
    const unknown = issuer.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { now: NOW, header: { kid: "x" } });
    for (let i = 0; i < 5; i++) await expect(guarded.verify(unknown, NOW)).rejects.toThrow(TokenError);
    expect(calls).toBe(1);
    clock = 31_000;
    await expect(guarded.verify(unknown, NOW)).rejects.toThrow(TokenError);
    expect(calls).toBe(2);
  });

  test("are trusted only for their lifetime, so a key the issuer stops publishing is refused", async () => {
    const next = devIssuer({ issuer: issuer.issuer, audience: issuer.audience, kid: "dev-2" });
    let published: Jwks = { keys: [...issuer.jwks.keys, ...next.jwks.keys] };
    let calls = 0;
    let clock = 0;
    const keys = jwksFromUrl("https://app.example/jwks", {
      maxAgeMs: 300_000,
      now: () => clock,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify(published));
      },
    });
    const retiring = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys });
    const signed = () => next.mint({ sub: MEMBER, tid: TENANT, kind: "member" }, { now: NOW });
    expect(await retiring.verify(signed(), NOW)).toMatchObject({ id: MEMBER });
    published = issuer.jwks; // the issuer retires dev-2
    clock = 299_000;
    expect(await retiring.verify(signed(), NOW)).toMatchObject({ id: MEMBER }); // still within the lifetime
    expect(calls).toBe(1);
    clock = 301_000;
    await expect(retiring.verify(signed(), NOW)).rejects.toThrow(TokenError);
    expect(await retiring.verify(member(), NOW)).toMatchObject({ id: MEMBER }); // dev-1 still holds
    expect(calls).toBe(2);
  });

  test("refuse every token once their lifetime is over and the URL cannot be fetched", async () => {
    let up = true;
    let calls = 0;
    let clock = 0;
    const keys = jwksFromUrl("https://app.example/jwks", {
      maxAgeMs: 300_000,
      minRefreshMs: 30_000,
      now: () => clock,
      fetch: async () => {
        calls += 1;
        return up ? new Response(JSON.stringify(issuer.jwks)) : new Response("", { status: 503 });
      },
    });
    const closed = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys });
    await closed.verify(member(), NOW);
    up = false;
    clock = 301_000;
    for (let i = 0; i < 3; i++) await expect(closed.verify(member(), NOW)).rejects.toThrow(/answered 503/);
    expect(calls).toBe(2); // asked again only once in the refresh interval
    up = true;
    clock = 332_000;
    expect(await closed.verify(member(), NOW)).toMatchObject({ id: MEMBER });
    expect(calls).toBe(3);
  });

  test("are fetched once for requests that need them at the same time", async () => {
    let calls = 0;
    const keys = jwksFromUrl("https://app.example/jwks", {
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify(issuer.jwks));
      },
    });
    const shared = new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys });
    await Promise.all(Array.from({ length: 5 }, () => shared.verify(member(), NOW)));
    expect(calls).toBe(1);
  });

  test("that are not Ed25519 are refused", async () => {
    const rsa = new TokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: staticKeys({ keys: [{ kty: "RSA", kid: "dev-1" }] }),
    });
    await expect(rsa.verify(member(), NOW)).rejects.toThrow(/not an Ed25519 key/);
  });
});
