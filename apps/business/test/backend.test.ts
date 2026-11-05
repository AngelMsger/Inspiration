import type { ApiError } from "@inspiration/contracts";
import type {
  InviteLink,
  InviteList,
  JoinPreview,
  MemberList,
  Session,
  SignOut,
} from "@inspiration/contracts/business";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COMPANY_HEADER, SIGN_IN_FAILED, TENANCY_SERVICE } from "../src/index.ts";
import { type Backend, PUBLIC_URL, SAMPLE, startBackend, ZHANG, ZHOU } from "./fixtures.ts";

let site: Backend;
beforeEach(async () => {
  site = await startBackend();
});
afterEach(() => site.close());

/** A company Zhou made, and Zhou's browser working in it. */
async function zhousCompany(name = "Qinghe Tech") {
  const zhou = await site.signIn(ZHOU);
  const { body } = await zhou.call<Session>("POST", "/api/companies", { name });
  return { zhou, session: body, tenantId: body.current?.tenant_id ?? "" };
}

/** Zhang, signed in and joined to the company through a link Zhou made. */
async function zhangJoins(zhou: Awaited<ReturnType<typeof zhousCompany>>["zhou"]) {
  const { body } = await zhou.call<InviteLink>("POST", "/api/invites", {});
  const zhang = await site.signIn(ZHANG);
  const joined = await zhang.call<Session>("POST", `/api/join/${body.url.split("/").at(-1)}`, {});
  return { zhang, link: body, session: joined.body };
}

describe("signing in", () => {
  test("goes to the provider and back to the page the person was on, with the session cookie", async () => {
    const b = site.browser();
    const out = await b.call(
      "GET",
      `/api/auth/sign-in?${new URLSearchParams({ return_to: "/ask?q=1", screen: "sign_up" })}`,
    );
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toMatch(/^https:\/\/idp\.example\//);
    expect(site.provider.requests.at(-1)?.screen).toBe("sign_up");

    const { code, state } = site.provider.code(ZHOU);
    const back = await b.call("GET", `/api/auth/callback?${new URLSearchParams({ code, state })}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/ask?q=1");
    const set = back.headers.getSetCookie()[0] ?? "";
    for (const attribute of ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"]) expect(set).toContain(attribute);

    const { body } = await b.call<Session>("GET", "/api/session");
    expect(body).toEqual({
      account: { name: "Zhou", email: "zhou@example.com", locale: "en" },
      companies: [],
      sample: { tenant_id: SAMPLE.id, name: SAMPLE.name },
    });
  });

  test("sends every failed sign-in to the page that says so, with no cookie", async () => {
    const b = site.browser();
    await b.call("GET", "/api/auth/sign-in");
    for (const query of ["code=c&state=unknown", "error=access_denied&state=s", ""]) {
      const back = await b.call("GET", `/api/auth/callback?${query}`);
      expect([back.status, back.headers.get("location"), b.session]).toEqual([302, SIGN_IN_FAILED, undefined]);
    }
  });

  test("refuses a callback opened in another browser than the one that began it", async () => {
    const mine = site.browser();
    await mine.call("GET", "/api/auth/sign-in");
    const callback = `/api/auth/callback?${new URLSearchParams(site.provider.code(ZHANG))}`;
    const other = site.browser();
    const refused = await other.call("GET", callback);
    expect([refused.headers.get("location"), other.session]).toEqual([SIGN_IN_FAILED, undefined]);
    expect((await mine.call("GET", callback)).headers.get("location")).toBe("/");
    expect(mine.session).toBeDefined();
    expect(mine.cookies.has("inspiration_sign_in")).toBe(false);
  });

  test("lands on the same page when the provider cannot be reached", async () => {
    site.provider.signInUrl = () => Promise.reject(new TypeError("fetch failed"));
    const out = await site.browser().call("GET", "/api/auth/sign-in");
    expect([out.status, out.headers.get("location")]).toEqual([302, SIGN_IN_FAILED]);
  });

  test("answers 401 to whoever is signed out", async () => {
    const b = site.browser();
    for (const [method, path] of [
      ["GET", "/api/session"],
      ["POST", "/api/companies"],
      ["GET", "/api/members"],
      ["POST", "/api/join/anything"],
      ["GET", "/api/v0/spaces"],
    ] as const) {
      expect((await b.call(method, path, method === "GET" ? undefined : {})).status).toBe(401);
    }
  });

  test("signs out here and at the provider", async () => {
    const zhou = await site.signIn(ZHOU);
    const out = await zhou.call<SignOut>("POST", "/api/auth/sign-out", {});
    expect(out.body).toEqual({ next: "https://idp.example/end" });
    expect(zhou.session).toBeUndefined();
    expect((await zhou.call("GET", "/api/session")).status).toBe(401);
  });

  test("answers 400 to a path or body it cannot read", async () => {
    expect((await site.browser().call("GET", "/api/join/%E0%A4%A")).status).toBe(400);
    const zhou = await site.signIn(ZHOU);
    expect((await zhou.call("POST", "/api/companies", undefined, { "content-type": "application/json" })).status).toBe(
      400,
    );
  });

  test("refuses a write that does not say it sends JSON", async () => {
    const zhou = await site.signIn(ZHOU);
    const out = await zhou.call<ApiError>("POST", "/api/companies", undefined, { "content-type": "text/plain" });
    expect(out.status).toBe(400);
    expect(out.body.error.code).toBe("bad_request");
  });
});

describe("companies", () => {
  test("a new company has its maker as super admin, and reaches the engine as the tenancy service", async () => {
    const { session, tenantId } = await zhousCompany("  Qinghe Tech ");
    expect(session.companies).toEqual([{ tenant_id: tenantId, name: "Qinghe Tech", role: "super_admin" }]);
    expect(session.current).toMatchObject({ tenant_id: tenantId, display_name: "Zhou", role: "super_admin" });

    const [tenant, member] = site.engine.calls;
    expect([tenant?.method, tenant?.path]).toEqual(["PUT", `/v0/tenants/${tenantId}`]);
    expect([member?.method, member?.path]).toEqual([
      "PUT",
      `/v0/tenants/${tenantId}/members/${session.current?.member_id}`,
    ]);
    expect(tenant?.claims).toMatchObject({
      sub: TENANCY_SERVICE,
      tid: tenantId,
      kind: "service",
      scope: "provision.directory",
    });
    expect(JSON.parse(member?.body ?? "")).toMatchObject({ roles: ["owner", "admin", "security_admin", "auditor"] });
    expect(tenant?.headers["idempotency-key"]).toBe(`tenant:${tenantId}:1`);
    // The account's own ID stays in the business layer.
    expect(JSON.stringify(site.engine.calls)).not.toMatch(/usr_/);
  });

  test("a session works in one company at a time, and a tab still showing another is told so", async () => {
    const { zhou, tenantId: first } = await zhousCompany("Alpha");
    const second = (await zhou.call<Session>("POST", "/api/companies", { name: "Beta" })).body.current?.tenant_id;
    expect(second).not.toBe(first);

    const switched = await zhou.call<Session>("POST", "/api/session", { tenant_id: first });
    expect(switched.body.current?.tenant_id).toBe(first);
    expect(switched.body.companies.map((c) => c.name)).toEqual(["Alpha", "Beta"]);
    expect((await zhou.call("GET", "/api/members", undefined, { [COMPANY_HEADER]: second ?? "" })).status).toBe(409);
    expect((await zhou.call("GET", "/api/members", undefined, { [COMPANY_HEADER]: first })).status).toBe(200);
    expect((await zhou.call("POST", "/api/session", { tenant_id: "ten_01UNKNOWN000000000000000000" })).status).toBe(
      404,
    );
  });

  test("renaming the account renames its member in every company", async () => {
    const { zhou } = await zhousCompany();
    const renamed = await zhou.call<Session>("PATCH", "/api/account", { name: "Zhou Min", locale: "zh-CN" });
    expect(renamed.body.account).toEqual({ name: "Zhou Min", email: "zhou@example.com", locale: "zh-CN" });
    expect(renamed.body.current?.display_name).toBe("Zhou Min");
    expect(JSON.parse(site.engine.calls.at(-1)?.body ?? "")).toMatchObject({ display_name: "Zhou Min", version: 2 });
    expect((await zhou.call("PATCH", "/api/account", { name: "  " })).status).toBe(400);
    expect((await zhou.call("PATCH", "/api/account", {})).status).toBe(400);
  });

  test("when the engine does not take a new company, the answer says so and the company is kept", async () => {
    const zhou = await site.signIn(ZHOU);
    site.engine.down = true;
    expect((await zhou.call("POST", "/api/companies", { name: "Qinghe Tech" })).status).toBe(502);
    const { body } = await zhou.call<Session>("GET", "/api/session");
    expect(body.companies.map((c) => c.name)).toEqual(["Qinghe Tech"]);
  });
});

describe("invite links and members", () => {
  test("a colleague joins through a link after signing in, as a member", async () => {
    const { zhou, tenantId } = await zhousCompany();
    const { body: link } = await zhou.call<InviteLink>("POST", "/api/invites", {});
    expect(link.url).toMatch(new RegExp(`^${PUBLIC_URL}/join/[A-Za-z0-9_-]+$`));
    expect(link.invite).toMatchObject({ created_by: { display_name: "Zhou" }, joined: 0 });
    const code = link.url.split("/").at(-1) ?? "";

    const stranger = site.browser();
    const preview = await stranger.call<JoinPreview>("GET", `/api/join/${code}`);
    expect(preview.body).toEqual({
      company: { name: "Qinghe Tech" },
      invited_by: { display_name: "Zhou" },
      expires_at: link.invite.expires_at,
    });
    expect((await stranger.call("POST", `/api/join/${code}`, {})).status).toBe(401);

    const zhang = await site.signIn(ZHANG);
    const joined = await zhang.call<Session>("POST", `/api/join/${code}`, {});
    expect(joined.body.current).toMatchObject({ tenant_id: tenantId, display_name: "Zhang", role: "member" });
    expect(JSON.parse(site.engine.calls.at(-1)?.body ?? "")).toMatchObject({ status: "active", roles: ["member"] });
    expect((await zhang.call<Session>("POST", `/api/join/${code}`, {})).body.current?.role).toBe("member");

    const members = await zhou.call<MemberList>("GET", "/api/members");
    expect(members.body.members.map((m) => [m.display_name, m.email, m.role])).toEqual([
      ["Zhang", "zhang@example.com", "member"],
      ["Zhou", "zhou@example.com", "super_admin"],
    ]);
    const invites = await zhou.call<InviteList>("GET", "/api/invites");
    expect(invites.body.invites.map((i) => i.joined)).toEqual([1]);

    expect((await zhou.call("DELETE", `/api/invites/${link.invite.id}`)).status).toBe(204);
    expect((await stranger.call("GET", `/api/join/${code}`)).status).toBe(404);
    expect((await zhou.call<InviteList>("GET", "/api/invites")).body.invites).toEqual([]);
  });

  test("only a super admin runs the company, and it always keeps one", async () => {
    const { zhou, session } = await zhousCompany();
    const { zhang, session: zhangs } = await zhangJoins(zhou);
    const zhouId = session.current?.member_id;
    const zhangId = zhangs.current?.member_id;

    expect((await zhang.call<ApiError>("POST", "/api/invites", {})).body.error?.code).toBe("forbidden");
    expect((await zhang.call("PUT", `/api/members/${zhouId}/role`, { role: "member" })).status).toBe(403);
    expect((await zhou.call<ApiError>("PUT", `/api/members/${zhouId}/role`, { role: "member" })).status).toBe(409);
    expect((await zhou.call("DELETE", `/api/members/${zhouId}`)).status).toBe(409);
    expect(
      (await zhou.call("PUT", "/api/members/mem_01NOBODY000000000000000000/role", { role: "member" })).status,
    ).toBe(404);

    const promoted = await zhou.call("PUT", `/api/members/${zhangId}/role`, { role: "super_admin" });
    expect(promoted.body).toEqual({
      member_id: zhangId,
      display_name: "Zhang",
      email: "zhang@example.com",
      role: "super_admin",
    });
    expect((await zhang.call("DELETE", `/api/members/${zhouId}`)).status).toBe(204);
    expect(JSON.parse(site.engine.calls.at(-1)?.body ?? "")).toMatchObject({ status: "left" });

    // Zhou has no company left: the session says so, and company calls are refused.
    expect((await zhou.call<Session>("GET", "/api/session")).body.companies).toEqual([]);
    expect((await zhou.call("GET", "/api/members")).status).toBe(400);
    expect((await zhou.call("GET", "/api/v0/spaces")).status).toBe(400);
  });
});

describe("the engine's API", () => {
  test("goes on as the member, with the company's newest consistency token", async () => {
    const { zhou, session, tenantId } = await zhousCompany();
    const answer = await zhou.call("GET", "/api/v0/spaces?manage=true", undefined, { [COMPANY_HEADER]: tenantId });
    expect(answer).toMatchObject({ status: 200, body: { spaces: [] } });

    const call = site.engine.calls.at(-1);
    expect(call?.path).toBe("/v0/spaces?manage=true");
    expect(call?.claims).toMatchObject({
      sub: session.current?.member_id,
      tid: tenantId,
      kind: "member",
      scope: "knowledge.read knowledge.propose",
      locale: "en",
      auth: { method: "password", mfa: false },
    });
    expect(Number(call?.claims.exp) - Number(call?.claims.iat)).toBe(300);
    // The member's provisioning was the company's last write.
    expect(call?.headers["x-inspiration-consistency"]).toBe("ct-2");
    expect(call?.headers.cookie).toBeUndefined();
    expect(call?.headers[COMPANY_HEADER]).toBeUndefined();
  });

  test("passes a write's body and idempotency key on, and remembers its consistency token", async () => {
    const { zhou } = await zhousCompany();
    const body = { name: "Finance", owner_ids: [] };
    const out = await zhou.call("POST", "/api/v0/spaces", body, { "idempotency-key": "k-1" });
    expect(out.body).toEqual({ echo: JSON.stringify(body), consistency_token: "ct-3" });
    expect(site.engine.calls.at(-1)?.headers["idempotency-key"]).toBe("k-1");
    await zhou.call("GET", "/api/v0/spaces");
    expect(site.engine.calls.at(-1)?.headers["x-inspiration-consistency"]).toBe("ct-3");
  });

  test("never passes provisioning on", async () => {
    const { zhou, tenantId } = await zhousCompany();
    const before = site.engine.calls.length;
    const out = await zhou.call("PUT", `/api/v0/tenants/${tenantId}/members/mem_01X0000000`, { status: "active" });
    expect(out.status).toBe(404);
    expect(site.engine.calls.length).toBe(before);
  });
});

test("publishes the keys the engine checks tokens with", async () => {
  const { status, body } = await site
    .browser()
    .call<{ keys: { kid: string; kty: string; crv: string }[] }>("GET", "/.well-known/jwks.json");
  expect(status).toBe(200);
  expect(body.keys).toEqual([expect.objectContaining({ kid: "test-1", kty: "OKP", crv: "Ed25519" })]);
});
