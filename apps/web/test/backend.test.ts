// The development backend: signing in and out, the session and members it answers as the
// business backend would, and that only the backend names the member the engine reads for.

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

const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listen = (s: Server) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));

beforeAll(async () => {
  // A stand-in engine that says what it was asked and by whom.
  engine = createServer((req, res) => {
    seen.push(req);
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
    const members = await call("/api/members", { headers: { cookie } });
    expect(contractErrors("MemberList", members.body)).toEqual([]);
    expect((members.body as { members: unknown[] }).members).toHaveLength(people.length);
    const changed = await call("/api/account", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });
    expect((changed.body as Session).account.locale).toBe("ja");
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
      headers: { cookie, "x-inspiration-member": "mem_SOMEONEELSE", "x-inspiration-tenant": "ten_OTHER" },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ path: "/v0/inbox?x=1", member: second.member });
    expect(seen[0]?.headers["x-inspiration-tenant"]).toBe(tenant);
  });

  test("forwards bodies and the engine's own status", async () => {
    const { cookie } = await signIn();
    const posted = await call("/api/v0/answers", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ question: "hotel cap" }),
    });
    expect(posted.body).toEqual({ path: "/v0/answers", member: first.member });
    expect((await call("/api/v0/missing", { headers: { cookie } })).status).toBe(404);
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
      headers: { cookie: `inspiration_member=${first.member}` },
    });
    server.close();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "the engine at http://127.0.0.1:9 did not answer" },
    });
  });
});

describe("the demo's upstream edits", () => {
  const { tenant, people } = loadPeople(PEOPLE);
  const headers = { cookie: `inspiration_member=${people[0]?.member}` };
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
