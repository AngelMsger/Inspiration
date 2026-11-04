// The development backend: who the page acts as, and that only the backend names the member
// the engine reads for.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { backend, loadPeople, type Session } from "../src/backend.ts";
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
    res.end(JSON.stringify({ path: req.url, member: req.headers["x-inspiration-member"] }));
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
  const [first, second] = people;

  test("reads the demo tenant's people", () => {
    expect(tenant).toMatch(/^ten_/);
    expect(people.length).toBeGreaterThan(1);
  });

  test("acts as the first person until another is picked", async () => {
    const { body } = await call("/api/session");
    expect((body as Session).person.member).toBe(first?.member);
    expect((body as Session).people).toEqual(people);
  });

  test("picking a person sets the cookie the engine calls are made with", async () => {
    const picked = await call("/api/session", { method: "POST", body: JSON.stringify({ member: second?.member }) });
    expect((picked.body as Session).person.member).toBe(second?.member);
    expect(picked.cookie).toContain(`inspiration_member=${second?.member}`);
    const cookie = (picked.cookie ?? "").split(";")[0] as string;

    seen = [];
    const { status, body } = await call("/api/v0/spaces?x=1", {
      headers: { cookie, "x-inspiration-member": "mem_SOMEONEELSE", "x-inspiration-tenant": "ten_OTHER" },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ path: "/v0/spaces?x=1", member: second?.member });
    expect(seen[0]?.headers["x-inspiration-tenant"]).toBe(tenant);
  });

  test("forwards bodies and the engine's own status", async () => {
    const posted = await call("/api/v0/answers", { method: "POST", body: JSON.stringify({ question: "hotel cap" }) });
    expect(posted.body).toEqual({ path: "/v0/answers", member: first?.member });
    expect((await call("/api/v0/missing")).status).toBe(404);
  });

  test("refuses someone outside the tenant, and leaves the page to the page", async () => {
    const refused = await call("/api/session", { method: "POST", body: JSON.stringify({ member: "mem_NOBODY" }) });
    expect(refused.status).toBe(400);
    expect(refused.cookie).toBeNull();
    expect((await call("/api/other")).status).toBe(404);
    expect((await call("/documents")).body).toBe("page");
  });

  test("says so when the engine does not answer", async () => {
    const down = backend({ engine: "http://127.0.0.1:9", tenant, people });
    const server = createServer((req, res) => down(req, res, () => res.end()));
    await listen(server);
    const res = await fetch(`${urlOf(server)}/api/v0/spaces`);
    server.close();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "the engine at http://127.0.0.1:9 did not answer" },
    });
  });
});

describe("the demo's upstream edits", () => {
  const { tenant, people } = loadPeople(PEOPLE);
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

  const list = async () => (await (await fetch(`${urlOf(demo)}/api/demo/updates`)).json()) as { updates: unknown[] };

  test("puts an update's files into the corpus, then syncs its source as the person", async () => {
    expect(await list()).toEqual({
      updates: [{ name: "revised", title: "The revised policy", source: "src_POLICIES", applied: false }],
    });
    seen = [];
    const res = await fetch(`${urlOf(demo)}/api/demo/updates/revised`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/v0/sources/src_POLICIES/sync", member: people[0]?.member });
    expect(seen[0]?.method).toBe("POST");
    expect(await readFile(join(corpus, "policies", "travel.md"), "utf8")).toBe("Hotels: 650 a night.\n");
    expect((await list()).updates).toEqual([expect.objectContaining({ applied: true })]);
  });

  test("an update that is not there is not found, and without a corpus there are none", async () => {
    expect((await fetch(`${urlOf(demo)}/api/demo/updates/other`, { method: "POST" })).status).toBe(404);
    expect(await (await fetch(`${urlOf(web)}/api/demo/updates`)).json()).toEqual({ updates: [] });
    expect((await fetch(`${urlOf(web)}/api/demo/updates/revised`, { method: "POST" })).status).toBe(404);
  });
});
