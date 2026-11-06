// The development backend: signing in and out, the session, members and invite links it answers
// as the business backend would, and that only the backend names the member the engine reads for.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE, contractErrors } from "@inspiration/contracts";
import type { Session } from "@inspiration/contracts/business";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { backend, loadPeople, returnTo } from "../src/backend.ts";
import { LOCALES, type Person } from "../src/people.ts";
import { Updates } from "../src/updates.ts";

const PEOPLE = fileURLToPath(new URL("../../../examples/corpus/people.yaml", import.meta.url));

let engine: Server;
let web: Server;
let seen: IncomingMessage[] = [];
/** The bodies the engine was sent, as seen lists the requests. */
let bodies: string[] = [];

const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listen = (s: Server) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));

beforeAll(async () => {
  // A stand-in engine that says what it was asked and by whom.
  engine = createServer(async (req, res) => {
    seen.push(req);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(req.url === "/v0/missing" ? 404 : 200, { "content-type": "application/json" });
    const tenant = req.url === "/v0/spaces" ? { tenant: { id: "ten_X", name: "Hengyuan" } } : {};
    res.end(JSON.stringify({ path: req.url, member: req.headers["x-inspiration-member"], ...tenant }));
  });
  await listen(engine);
  const middleware = backend({ engine: urlOf(engine), ...loadPeople(PEOPLE) });
  web = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("page");
    }),
  );
  await listen(web);
});

afterAll(() => {
  web?.close();
  engine?.close();
});

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${urlOf(web)}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie"),
    body: text.startsWith("{") ? JSON.parse(text) : text,
  };
}

describe("development backend", () => {
  const { tenant, people } = loadPeople(PEOPLE);
  const [first, second] = people as [Person, Person];
  const cookieOf = (set: string | null) => (set ?? "").split(";")[0] as string;
  /** The headers of a page showing the company, as the web app names it. */
  const inCompany = (cookie: string) => ({ cookie, "x-inspiration-company": tenant });
  const signIn = async (back = "/inbox") => {
    const res = await fetch(`${urlOf(web)}/api/auth/sign-in?return_to=${encodeURIComponent(back)}`, {
      redirect: "manual",
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      cookie: cookieOf(res.headers.get("set-cookie")),
    };
  };

  test("reads the demo company's people", () => {
    expect(tenant).toMatch(/^ten_/);
    expect(people.length).toBeGreaterThan(1);
  });

  test("answers 401 until someone signs in, then the first person's session", async () => {
    expect((await call("/api/session")).status).toBe(401);
    expect((await call("/api/v0/spaces")).status).toBe(401);
    const signed = await signIn("/ask?q=hotel");
    expect([signed.status, signed.location]).toEqual([302, "/ask?q=hotel"]);
    const { body } = await call("/api/session", { headers: { cookie: signed.cookie } });
    expect(contractErrors("Session", body)).toEqual([]);
    expect(body).toEqual({
      account: { name: first.name, email: first.email ?? "", locale: first.locale ?? "en" },
      companies: [{ tenant_id: tenant, name: "Hengyuan", role: "member" }],
      current: { tenant_id: tenant, member_id: first.member, display_name: first.name, role: "member" },
    } satisfies Session);
  });

  test("offers the languages the contracts allow an account", () => {
    expect(LOCALES).toEqual(BUNDLE.$defs.UiLocale?.enum);
  });

  test("sends a sign-in back only to a path on this site", () => {
    expect([returnTo("/inbox"), returnTo("//evil.example"), returnTo("/\\evil.example"), returnTo(null)]).toEqual([
      "/inbox",
      "/",
      "/",
      "/",
    ]);
  });

  test("lists the company's members, changes the account, and signs out", async () => {
    const { cookie } = await signIn();
    const members = await call("/api/members", { headers: inCompany(cookie) });
    expect(contractErrors("MemberList", members.body)).toEqual([]);
    expect((members.body as { members: unknown[] }).members).toHaveLength(people.length);
    const changed = await call("/api/account", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });
    expect((changed.body as Session).account.locale).toBe("ja");
    // The engine writes for the account in its language, as the business backend's token says.
    seen = [];
    await call("/api/v0/inbox", { headers: { ...inCompany(cookie), "x-inspiration-locale": "en" } });
    expect(seen[0]?.headers["x-inspiration-locale"]).toBe("ja");
    // What the contract refuses: another language, nothing to change, a field it does not have.
    for (const refused of ['{"locale":"fr"}', "{}", '{"name":"Lin","email":"lin@example.com"}']) {
      const wrong = await call("/api/account", { method: "PATCH", headers: { cookie }, body: refused });
      expect([refused, wrong.status]).toEqual([refused, 400]);
    }
    expect(
      (await call("/api/session", { method: "POST", headers: { cookie }, body: '{"tenant_id":"ten_01QINGHE"}' }))
        .status,
    ).toBe(404);
    expect(
      (await call("/api/session", { method: "POST", headers: { cookie }, body: '{"tenant_id":"Qinghe"}' })).status,
    ).toBe(400);
    const out = await call("/api/auth/sign-out", { method: "POST", headers: { cookie } });
    expect(contractErrors("SignOut", out.body)).toEqual([]);
    expect(out.cookie).toContain("Max-Age=0");
    expect((out.body as { next: string }).next).toMatch(/^http:\/\//);
  });

  test("acting as a person sets the cookie the engine calls are made with", async () => {
    const { cookie: signedIn } = await signIn();
    const picked = await call("/api/demo/act-as", {
      method: "POST",
      headers: { cookie: signedIn },
      body: JSON.stringify({ member: second.member }),
    });
    expect((picked.body as Session).current?.member_id).toBe(second.member);
    expect(picked.cookie).toContain(`inspiration_member=${second.member}`);
    const cookie = cookieOf(picked.cookie);

    seen = [];
    const { status, body } = await call("/api/v0/inbox?x=1", {
      headers: { ...inCompany(cookie), "x-inspiration-member": "mem_SOMEONEELSE", "x-inspiration-tenant": "ten_OTHER" },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ path: "/v0/inbox?x=1", member: second.member });
    expect(seen[0]?.headers["x-inspiration-tenant"]).toBe(tenant);
  });

  test("refuses a call that names no company, or another than the session's", async () => {
    const { cookie } = await signIn();
    seen = [];
    const elsewhere = await call("/api/v0/inbox", { headers: { cookie, "x-inspiration-company": "ten_01QINGHE" } });
    expect([elsewhere.status, (elsewhere.body as { error: { code: string } }).error.code]).toEqual([409, "conflict"]);
    for (const path of ["/api/v0/inbox", "/api/members", "/api/tokens", "/api/demo/people"]) {
      const unnamed = await call(path, { headers: { cookie } });
      expect([path, unnamed.status, (unnamed.body as { error: { code: string } }).error.code]).toEqual([
        path,
        400,
        "bad_request",
      ]);
    }
    expect(seen).toEqual([]);
    const here = await call("/api/v0/inbox", { headers: { cookie, "x-inspiration-company": tenant } });
    expect(here.status).toBe(200);
    // The company the page names is for the backend; the engine hears the tenant from it alone.
    expect(seen[0]?.headers["x-inspiration-company"]).toBeUndefined();
  });

  test("forwards every write's body, and the key that makes a new space once", async () => {
    const { cookie } = await signIn();
    seen = [];
    bodies = [];
    const headers = { ...inCompany(cookie), "content-type": "application/json", "idempotency-key": "space-1" };
    await call("/api/v0/spaces", { method: "POST", headers, body: '{"name":"Payroll"}' });
    const owners = '{"owner_ids":["mem_1"]}';
    await call("/api/v0/spaces/spc_1/owners", { method: "PUT", headers: inCompany(cookie), body: owners });
    await call("/api/v0/spaces/spc_1", { method: "PATCH", headers: inCompany(cookie), body: '{"name":"Pay"}' });
    expect(seen.map((r) => `${r.method} ${r.url} ${r.headers["idempotency-key"] ?? "-"}`)).toEqual([
      "POST /v0/spaces space-1",
      "PUT /v0/spaces/spc_1/owners -",
      "PATCH /v0/spaces/spc_1 -",
    ]);
    expect(bodies).toEqual(['{"name":"Payroll"}', '{"owner_ids":["mem_1"]}', '{"name":"Pay"}']);
  });

  test("forwards a file as its bytes and type, larger than other bodies may be", async () => {
    const { cookie } = await signIn();
    seen = [];
    bodies = [];
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const big = "x".repeat(100 * 1024);
    const path = "/v0/spaces/spc_1/files/%E5%88%B6%E5%BA%A6/a.docx";
    const modified = "2026-11-04T09:12:00.000Z";
    const headers = { ...inCompany(cookie), "content-type": docx, "x-inspiration-modified": modified };
    const put = await call(`/api${path}`, { method: "PUT", headers, body: big });
    expect(put.status).toBe(200);
    const sent = seen.map((r) => [r.method, r.url, r.headers["content-type"], r.headers["x-inspiration-modified"]]);
    expect(sent).toEqual([["PUT", path, docx, modified]]);
    expect(bodies[0]?.length).toBe(big.length);
    const refused = await call("/api/v0/answers", { method: "POST", headers: inCompany(cookie), body: big });
    expect([refused.status, refused.body.error?.code]).toEqual([413, "too_large"]);
    expect(seen).toHaveLength(1);
  });

  test("forwards bodies and the engine's own status", async () => {
    const { cookie } = await signIn();
    const posted = await call("/api/v0/answers", {
      method: "POST",
      headers: inCompany(cookie),
      body: JSON.stringify({ question: "hotel cap" }),
    });
    expect(posted.body).toEqual({ path: "/v0/answers", member: first.member });
    expect((await call("/api/v0/missing", { headers: inCompany(cookie) })).status).toBe(404);
  });

  test("refuses someone outside the company, and leaves the page to the page", async () => {
    const { cookie } = await signIn();
    const refused = await call("/api/demo/act-as", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ member: "mem_NOBODY" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.cookie).toBeNull();
    expect((await call("/api/other", { headers: { cookie } })).status).toBe(404);
    expect((await call("/documents")).body).toBe("page");
  });

  test("says so when the engine does not answer", async () => {
    const down = backend({ engine: "http://127.0.0.1:9", tenant, people });
    const server = createServer((req, res) => down(req, res, () => res.end()));
    await listen(server);
    const res = await fetch(`${urlOf(server)}/api/v0/spaces`, {
      headers: { cookie: `inspiration_member=${first.member}`, "x-inspiration-company": tenant },
    });
    server.close();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "the engine at http://127.0.0.1:9 did not answer" },
    });
  });
});

describe("the company's people and invite links", () => {
  const { tenant, people } = loadPeople(PEOPLE);
  const first = people[0] as Person;
  const admin = people.find((p) => p.role === "super_admin") as Person;
  // A backend of its own, since these tests change the company.
  let company: Server;
  const as = (person?: Person): Record<string, string> =>
    person ? { cookie: `inspiration_member=${person.member}`, "x-inspiration-company": tenant } : {};
  const ask = async (person: Person | undefined, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${urlOf(company)}${path}`, {
      method,
      headers: as(person),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  beforeAll(async () => {
    const middleware = backend({ engine: urlOf(engine), tenant, people });
    company = createServer((req, res) => middleware(req, res, () => res.end()));
    await listen(company);
  });

  afterAll(() => {
    company?.close();
  });

  test("the demo has a super admin who is not the first person", () => {
    expect(admin).toBeDefined();
    expect(admin).not.toBe(first);
  });

  test("a member sees the members, and is refused what only a super admin may do", async () => {
    expect((await ask(first, "GET", "/api/members")).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/api/invites"],
      ["POST", "/api/invites", {}],
      ["PUT", `/api/members/${admin.member}/role`, { role: "member" }],
      ["DELETE", `/api/members/${admin.member}`],
    ] as const) {
      const refused = await ask(first, method, path, body);
      expect([path, refused.status, refused.body?.error.code]).toEqual([path, 403, "forbidden"]);
    }
  });

  test("a super admin changes roles, and the company keeps a super admin", async () => {
    const last = await ask(admin, "PUT", `/api/members/${admin.member}/role`, { role: "member" });
    expect([last.status, last.body.error.code]).toEqual([409, "conflict"]);
    const wrong = await ask(admin, "PUT", `/api/members/${first.member}/role`, { role: "owner" });
    expect(wrong.status).toBe(400);
    const nobody = await ask(admin, "PUT", "/api/members/mem_01NOBODY0000/role", { role: "member" });
    expect(nobody.status).toBe(404);
    const promoted = await ask(admin, "PUT", `/api/members/${first.member}/role`, { role: "super_admin" });
    expect(contractErrors("CompanyMember", promoted.body)).toEqual([]);
    expect((await ask(first, "GET", "/api/session")).body.current.role).toBe("super_admin");
    await ask(admin, "PUT", `/api/members/${first.member}/role`, { role: "member" });
  });

  test("a link is shown to anyone holding it, joins someone who left, and stops once revoked", async () => {
    const made = await ask(admin, "POST", "/api/invites", {});
    expect(made.status).toBe(201);
    expect(contractErrors("InviteLink", made.body)).toEqual([]);
    const url = new URL(made.body.url);
    expect([url.host, url.pathname]).toEqual([new URL(urlOf(company)).host, expect.stringMatching(/^\/join\//)]);
    const preview = await ask(undefined, "GET", `/api${url.pathname}`);
    expect(contractErrors("JoinPreview", preview.body)).toEqual([]);
    expect(preview.body).toMatchObject({ company: { name: "Hengyuan" }, invited_by: { display_name: admin.name } });
    expect((await ask(undefined, "POST", `/api${url.pathname}`, {})).status).toBe(401);

    // The member leaves: they keep their account, with no company to act in.
    expect((await ask(admin, "DELETE", `/api/members/${first.member}`)).status).toBe(204);
    const outside = await ask(first, "GET", "/api/session");
    expect([outside.body.companies, outside.body.current]).toEqual([[], undefined]);
    expect((await ask(first, "GET", "/api/v0/inbox")).status).toBe(400);
    expect((await ask(first, "GET", "/api/members")).status).toBe(400);
    const listed = (await ask(admin, "GET", "/api/members")).body.members as { member_id: string }[];
    expect(listed.map((m) => m.member_id)).not.toContain(first.member);

    // They come back by the link, and the link counts them.
    const joined = await ask(first, "POST", `/api${url.pathname}`, {});
    expect(contractErrors("Session", joined.body)).toEqual([]);
    expect(joined.body.current).toMatchObject({ tenant_id: tenant, member_id: first.member, role: "member" });
    const open = await ask(admin, "GET", "/api/invites");
    expect(contractErrors("InviteList", open.body)).toEqual([]);
    expect(open.body.invites).toMatchObject([{ id: made.body.invite.id, joined: 1 }]);

    expect((await ask(admin, "DELETE", `/api/invites/${made.body.invite.id}`)).status).toBe(204);
    expect((await ask(undefined, "GET", `/api${url.pathname}`)).status).toBe(404);
    expect((await ask(admin, "GET", "/api/invites")).body.invites).toEqual([]);
  });

  test("a member makes an access token, sees it once, and revokes it; a super admin sees every member's", async () => {
    const made = await ask(first, "POST", "/api/tokens", { name: "Claude", spaces: "all", days: 30 });
    expect(made.status).toBe(201);
    expect(contractErrors("CreatedAccessToken", made.body)).toEqual([]);
    expect((await ask(first, "POST", "/api/tokens", { name: "Too long", spaces: "all", days: 91 })).status).toBe(400);
    const own = await ask(first, "GET", "/api/tokens");
    expect(contractErrors("AccessTokenList", own.body)).toEqual([]);
    expect(own.body.mcp_url).toBe(`${urlOf(company)}/mcp`);
    expect(own.body.tokens).toMatchObject([{ id: made.body.token.id, name: "Claude" }]);
    expect((await ask(first, "GET", "/api/tokens?all=true")).status).toBe(403);
    const all = await ask(admin, "GET", "/api/tokens?all=true");
    expect(all.body.tokens).toMatchObject([{ member: { member_id: first.member } }]);
    expect((await ask(first, "DELETE", `/api/tokens/${made.body.token.id}`)).status).toBe(204);
    expect((await ask(first, "DELETE", `/api/tokens/${made.body.token.id}`)).status).toBe(404);
    expect((await ask(first, "GET", "/api/tokens")).body.tokens).toEqual([]);
  });
});

describe("the demo's upstream edits", () => {
  const { tenant, people } = loadPeople(PEOPLE);
  const headers = { cookie: `inspiration_member=${people[0]?.member}`, "x-inspiration-company": tenant };
  let corpus: string;
  let demo: Server;

  beforeAll(async () => {
    corpus = await mkdtemp(join(tmpdir(), "inspiration-updates-"));
    await mkdir(join(corpus, "updates", "revised", "policies"), { recursive: true });
    await writeFile(
      join(corpus, "updates", "revised", "update.yaml"),
      "title: The revised policy\nsource: src_POLICIES\n",
    );
    await writeFile(join(corpus, "updates", "revised", "policies", "travel.md"), "Hotels: 650 a night.\n");
    const middleware = backend({ engine: urlOf(engine), tenant, people, updates: new Updates(corpus) });
    demo = createServer((req, res) => middleware(req, res, () => res.end()));
    await listen(demo);
  });

  afterAll(async () => {
    demo?.close();
    await rm(corpus, { recursive: true, force: true });
  });

  const list = async () =>
    (await (await fetch(`${urlOf(demo)}/api/demo/updates`, { headers })).json()) as { updates: unknown[] };

  test("puts an update's files into the corpus, then syncs its source as the person", async () => {
    expect(await list()).toEqual({
      updates: [{ name: "revised", title: "The revised policy", source: "src_POLICIES", applied: false }],
    });
    seen = [];
    const res = await fetch(`${urlOf(demo)}/api/demo/updates/revised`, { method: "POST", body: "{}", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/v0/sources/src_POLICIES/sync", member: people[0]?.member });
    expect(seen[0]?.method).toBe("POST");
    expect(await readFile(join(corpus, "policies", "travel.md"), "utf8")).toBe("Hotels: 650 a night.\n");
    expect((await list()).updates).toEqual([expect.objectContaining({ applied: true })]);
  });

  test("an update that is not there is not found, and without a corpus there are none", async () => {
    expect((await fetch(`${urlOf(demo)}/api/demo/updates/other`, { method: "POST", headers })).status).toBe(404);
    expect(await (await fetch(`${urlOf(web)}/api/demo/updates`, { headers })).json()).toEqual({ updates: [] });
    expect((await fetch(`${urlOf(web)}/api/demo/updates/revised`, { method: "POST", headers })).status).toBe(404);
  });
});
