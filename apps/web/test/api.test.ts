// Switching company while calls are on their way, with two companies that hold the same member ID
// and a backend whose session works in one company at a time, as the business backend's does.
// Answers come back in the order each test sets: a frame never reads or acts in a company other
// than the one it shows.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiFailure, api, apiIn, showCompany } from "../src/api.ts";
import { switcher } from "../src/switching.ts";

const HENGYUAN = "ten_01HENGYUAN";
const QINGHE = "ten_01QINGHE";
const SAME = "mem_01SAMEMEMBER";

/** A promise the test settles by hand. */
function later() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const settle = () => new Promise((done) => setTimeout(done, 0));
const PENDING = Symbol("pending");
/** What a call gave by now, or PENDING while it has given nothing. */
const byNow = <T>(call: Promise<T>) => Promise.race([call, settle().then(() => PENDING)]);

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/**
 * The backend: the session's company, every call as it arrived, what it did, calls to hold back,
 * calls whose answer is lost after they are done, and calls that fail once.
 */
function backend() {
  const server = {
    current: HENGYUAN,
    calls: [] as { route: string; company: string | null }[],
    done: [] as string[],
    held: new Map<string, Promise<void>>(),
    lost: new Set<string>(),
    failOnce: new Set<string>(),
  };
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = input.slice("/api".length);
    const route = `${init?.method ?? "GET"} ${path}`;
    const company = new Headers(init?.headers).get("x-inspiration-company");
    server.calls.push({ route, company });
    await server.held.get(route);
    // The session's company when the call is handled, not when it was sent.
    if (route === "POST /session") {
      server.current = (JSON.parse(String(init?.body)) as { tenant_id: string }).tenant_id;
      if (server.lost.has(route)) throw new TypeError("network down");
      return json({ current: { tenant_id: server.current, member_id: SAME } });
    }
    if (route === "GET /session") return json({ current: { tenant_id: server.current, member_id: SAME } });
    if (company && company !== server.current) return json({ error: { code: "conflict", message: "moved" } }, 409);
    if (server.failOnce.delete(route)) return json({ error: { code: "internal", message: "engine down" } }, 502);
    server.done.push(`${route} in ${server.current}`);
    return json({ tenant: { id: server.current, name: server.current }, spaces: [], items: [] });
  }) as typeof fetch;
  return server;
}

describe("calls while the company changes", () => {
  const original = globalThis.fetch;
  let moved = 0;
  beforeEach(() => {
    moved = 0;
    showCompany(HENGYUAN, () => moved++);
  });
  afterEach(() => {
    globalThis.fetch = original;
    showCompany(undefined, () => {});
  });

  test("the frame names the company it shows; switching and the session name none", async () => {
    const server = backend();
    await api.inbox();
    await api.enterCompany(QINGHE);
    await api.session();
    await apiIn(QINGHE).spaces();
    expect(server.calls).toEqual([
      { route: "GET /v0/inbox", company: HENGYUAN },
      { route: "POST /session", company: null },
      { route: "GET /session", company: null },
      { route: "GET /v0/spaces", company: QINGHE },
    ]);
  });

  test("once the session is in the next company, the old frame reads nothing there", async () => {
    const server = backend();
    await api.enterCompany(QINGHE);
    const old = api.inbox();
    expect(await byNow(old)).toBe(PENDING);
    expect(moved).toBe(1);
    // The next company's frame is read with its own calls.
    expect(await apiIn(QINGHE).spaces()).toMatchObject({ tenant: { id: QINGHE } });
    expect(server.done).toEqual([`GET /v0/spaces in ${QINGHE}`]);
  });

  test("an action the old frame sent before the switch is not done in the next company", async () => {
    const server = backend();
    const hold = later();
    server.held.set("POST /v0/todos/todo_1/resolve", hold.promise);
    const resolving = api.resolve("todo_1", { with: "confirm" });
    await settle();
    await api.enterCompany(QINGHE);
    hold.resolve();
    expect(await byNow(resolving)).toBe(PENDING);
    expect(server.done).toEqual([]);
  });

  test("a read for the next company fails when the session has moved on again, and the next read succeeds", async () => {
    const server = backend();
    await api.enterCompany(QINGHE);
    // Another tab moves the session on before this one has read Qinghe.
    server.current = HENGYUAN;
    const failed = await apiIn(QINGHE)
      .spaces()
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiFailure);
    expect([(failed as ApiFailure).status, (failed as ApiFailure).code]).toEqual([409, "conflict"]);
    expect(await apiIn(server.current).spaces()).toMatchObject({ tenant: { id: HENGYUAN } });
  });

  test("a switch whose library is slow: the frame is busy, its calls are refused, then it reads the next company", async () => {
    const server = backend();
    let busy = false;
    const change = switcher((on) => {
      busy = on;
    });
    const hold = later();
    const switched = change(
      () => api.enterCompany(QINGHE),
      async () => {
        await hold.promise;
        return apiIn(QINGHE).spaces();
      },
    );
    await settle();
    expect([server.current, busy]).toEqual([QINGHE, true]);
    // A call the old frame still makes meanwhile, as when the browser goes back a page.
    const old = api.topics("spc_1");
    hold.resolve();
    expect(await switched).toMatchObject({ value: { tenant: { id: QINGHE } } });
    expect(busy).toBe(false);
    expect(await byNow(old)).toBe(PENDING);
    // Once the next frame is shown, its calls name the next company.
    showCompany(QINGHE, () => moved++);
    expect(await api.inbox()).toMatchObject({ tenant: { id: QINGHE } });
    expect(server.done).toEqual([`GET /v0/spaces in ${QINGHE}`, `GET /v0/inbox in ${QINGHE}`]);
  });

  test("the backend switched but its answer was lost: the session is read before the frame takes clicks", async () => {
    const server = backend();
    server.lost.add("POST /session");
    let busy = false;
    const change = switcher((on) => {
      busy = on;
    });
    const hold = later();
    const switched = change(
      () => api.enterCompany(QINGHE),
      async (s) => {
        await hold.promise;
        return apiIn((s as { current: { tenant_id: string } }).current.tenant_id).spaces();
      },
      api.session,
    );
    await settle();
    expect([server.current, busy]).toEqual([QINGHE, true]);
    // A click the old frame would make, were it not inert: it is not done in the next company.
    const resolving = api.resolve("todo_1", { with: "confirm" });
    hold.resolve();
    const result = await switched;
    expect(result?.value).toMatchObject({ tenant: { id: QINGHE } });
    expect(String(result?.lost?.error)).toContain("network down");
    expect(busy).toBe(false);
    expect(await byNow(resolving)).toBe(PENDING);
    expect(server.done).toEqual([`GET /v0/spaces in ${QINGHE}`]);
  });

  test("the next company's library fails at first: its frame reads it again, in the next company", async () => {
    const server = backend();
    server.failOnce.add("GET /v0/spaces");
    const change = switcher();
    const switched = await change(
      () => api.enterCompany(QINGHE),
      () =>
        apiIn(QINGHE)
          .spaces()
          .catch(() => undefined),
    );
    expect(switched).toEqual({ value: undefined });
    // The next frame is shown without a library and reads it itself.
    showCompany(QINGHE, () => moved++);
    expect(await api.spaces()).toMatchObject({ tenant: { id: QINGHE } });
    expect(server.calls.filter((c) => c.route === "GET /v0/spaces").map((c) => c.company)).toEqual([QINGHE, QINGHE]);
  });
});
