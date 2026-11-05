import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OidcProvider } from "../src/index.ts";
import { TestIssuer } from "./fixtures.ts";

let idp: TestIssuer;
beforeAll(async () => {
  idp = await TestIssuer.start();
});
afterAll(() => idp.close());
beforeEach(() => {
  idp.claims = { nonce: "n-1", email: "zhou@example.com", email_verified: true, name: "Zhou" };
  idp.kid = "key-1";
  idp.signWith = undefined;
});

const provider = () =>
  new OidcProvider({
    issuer: idp.issuer,
    clientId: "web",
    clientSecret: "s3cret:/",
    redirectUri: "https://inspiration.example/api/auth/callback",
    signedOutUri: "https://inspiration.example/",
  });

describe("the OIDC provider", () => {
  test("sends the browser to the provider with PKCE, and to its registration screen for sign-up", async () => {
    const url = new URL(
      await provider().signInUrl({ state: "s", nonce: "n", challenge: "c", screen: "sign_up", locale: "zh-CN" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "web",
      redirect_uri: "https://inspiration.example/api/auth/callback",
      response_type: "code",
      scope: "openid profile email",
      state: "s",
      nonce: "n",
      code_challenge: "c",
      code_challenge_method: "S256",
      first_screen: "register",
      ui_locales: "zh-CN",
    });
  });

  test("exchanges the code as a confidential client and reads who signed in", async () => {
    expect(await provider().finish("the-code", "the-verifier", "n-1")).toEqual({
      subject: "logto-user-1",
      email: "zhou@example.com",
      email_verified: true,
      name: "Zhou",
    });
    const { form, authorization } = idp.lastToken ?? {};
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://inspiration.example/api/auth/callback",
      code_verifier: "the-verifier",
    });
    expect(authorization).toBe(`Basic ${Buffer.from("web:s3cret%3A%2F").toString("base64")}`);
  });

  test.each([
    ["another sign-in's nonce", { nonce: "n-2" }, "another sign-in"],
    ["another client", { aud: "other" }, "another client"],
    ["another issuer", { iss: "https://evil.example/oidc" }, "another issuer"],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, "expired"],
    ["no subject", { sub: "" }, "names nobody"],
  ])("refuses %s", async (_, claims, message) => {
    idp.claims = { ...idp.claims, ...claims };
    await expect(provider().finish("c", "v", "n-1")).rejects.toThrow(message);
  });

  test("refuses a token signed with a key the provider does not publish", async () => {
    idp.signWith = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey;
    await expect(provider().finish("c", "v", "n-1")).rejects.toThrow("signature");
  });

  test("reads the keys again when the provider rotates them", async () => {
    const p = provider();
    await p.finish("c", "v", "n-1");
    idp.kid = "key-2";
    await expect(p.finish("c", "v", "n-1")).resolves.toMatchObject({ subject: "logto-user-1" });
  });

  test("signs out at the provider too", async () => {
    const url = new URL(await provider().signOutUrl());
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/session/end`);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("https://inspiration.example/");
  });
});
