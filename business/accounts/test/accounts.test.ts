import { describe, expect, test } from "vitest";
import { Accounts, localeOf, type ProviderIdentity, SESSION_DAYS, SIGN_IN_MINUTES, sitePath } from "../src/index.ts";
import { BACKENDS, FakeProvider, storeTest } from "./fixtures.ts";

const ZHOU: ProviderIdentity = { subject: "sub-zhou", email: "zhou@example.com", email_verified: true, name: "Zhou" };

class Clock {
  now = new Date("2026-11-05T03:00:00.000Z");
  read = () => this.now;
  advance(minutes: number) {
    this.now = new Date(this.now.getTime() + minutes * 60 * 1000);
  }
}

test.each([
  ["/ask?q=hotel+cap&space=spc_1", "/ask?q=hotel+cap&space=spc_1"],
  ["/join/abc", "/join/abc"],
  ["//evil.example/x", "/"],
  ["/\\evil.example", "/"],
  ["/\t/evil.example", "/"],
  ["https://evil.example/", "/"],
  [undefined, "/"],
])("going back to %s stays on the site", (returnTo, path) => {
  expect(sitePath(returnTo)).toBe(path);
});

test.each([
  ["zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"],
  ["ja-JP", "ja"],
  ["fr-FR, en-GB;q=0.5", "en"],
  ["de", "en"],
  [undefined, "en"],
])("a browser asking for %s gets %s", (header, locale) => {
  expect(localeOf(header)).toBe(locale);
});

describe.each(BACKENDS)("accounts on $backend", ({ backend, skip }) => {
  const it = storeTest(backend);

  const signIn = async (accounts: Accounts, provider: FakeProvider, who: ProviderIdentity = ZHOU, returnTo = "/") => {
    await accounts.startSignIn({ returnTo, screen: "sign_in" });
    const { code, state } = provider.code(who);
    return accounts.finishSignIn({ state, code, locale: "zh-CN" });
  };

  it.skipIf(skip)("signs a new person up, then signs them in to the same account", async ({ store }) => {
    const provider = new FakeProvider();
    const accounts = new Accounts(store, provider);
    const started = await accounts.startSignIn({ returnTo: "/join/abc", screen: "sign_up", locale: "ja" });
    expect(started.url).toContain("idp.example");
    expect(provider.requests[0]).toMatchObject({ screen: "sign_up", locale: "ja", state: started.state });

    const { code, state } = provider.code(ZHOU);
    const first = await accounts.finishSignIn({ state, code, locale: "zh-CN" });
    expect(first.returnTo).toBe("/join/abc");
    expect(first.user).toMatchObject({ name: "Zhou", email: "zhou@example.com", locale: "zh-CN" });
    expect(first.user.id).toMatch(/^usr_/);

    const again = await signIn(accounts, provider);
    expect(again.user.id).toBe(first.user.id);
    expect(again.token).not.toBe(first.token);
    expect((await accounts.session(first.token))?.user.id).toBe(first.user.id);
  });

  it.skipIf(skip)("uses a sign-in once, and only while it lasts", async ({ store }) => {
    const provider = new FakeProvider();
    const clock = new Clock();
    const accounts = new Accounts(store, provider, { clock: clock.read });
    await accounts.startSignIn({ screen: "sign_in" });
    const { code, state } = provider.code(ZHOU);
    await accounts.finishSignIn({ state, code, locale: "en" });
    await expect(accounts.finishSignIn({ state, code, locale: "en" })).rejects.toThrow("expired or was already used");

    await accounts.startSignIn({ screen: "sign_in" });
    const late = provider.code(ZHOU);
    clock.advance(SIGN_IN_MINUTES + 1);
    await expect(accounts.finishSignIn({ ...late, locale: "en" })).rejects.toThrow("expired");
  });

  it.skipIf(skip)("needs an email address for a new account", async ({ store }) => {
    const provider = new FakeProvider();
    const accounts = new Accounts(store, provider);
    await expect(signIn(accounts, provider, { subject: "no-mail", email_verified: false })).rejects.toThrow(
      "email address",
    );
  });

  it.skipIf(skip)("keeps the session's company, ends it on sign-out, and expires it", async ({ store }) => {
    const provider = new FakeProvider();
    const clock = new Clock();
    const accounts = new Accounts(store, provider, { clock: clock.read });
    const { token } = await signIn(accounts, provider);
    const signedIn = await accounts.session(token);
    expect(signedIn?.session.tenant_id).toBeUndefined();
    await accounts.workIn(signedIn?.session as never, "ten_01JC000000000000000000TEN1");
    expect((await accounts.session(token))?.session.tenant_id).toBe("ten_01JC000000000000000000TEN1");

    expect(await accounts.signOut((await accounts.session(token))?.session)).toBe("https://idp.example/end");
    expect(await accounts.session(token)).toBeUndefined();

    const later = await signIn(accounts, provider);
    clock.advance(SESSION_DAYS * 24 * 60);
    expect(await accounts.session(later.token)).toBeUndefined();
    expect(await accounts.session(undefined)).toBeUndefined();
    expect(await accounts.session("made-up")).toBeUndefined();
  });

  it.skipIf(skip)("changes the account's name and language", async ({ store }) => {
    const provider = new FakeProvider();
    const accounts = new Accounts(store, provider);
    const { token, user } = await signIn(accounts, provider);
    await accounts.update(user, { name: "Zhou Min", locale: "ja" });
    expect((await accounts.session(token))?.user).toMatchObject({ name: "Zhou Min", locale: "ja" });
  });
});
