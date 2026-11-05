/**
 * The web app's backend as the development server runs it, standing in for the business
 * backend (apps/business) with the same browser API over one demo company (people.yaml).
 * There is no identity provider here: signing in, or signing up, signs in as the company's
 * first person, and a cookie remembers who is signed in. Every call under /api/v0/ goes on to
 * the engine's HTTP API as that member, in the engine's development identity headers. The
 * page cannot name a member itself: the backend builds the headers it forwards, so identity
 * headers from the browser never reach the engine. Under /api/demo/ are what only the demo
 * has: acting as another person of the company, and its upstream edits.
 *
 *     GET   /api/session           Session, or 401 when signed out
 *     GET   /api/auth/sign-in      ?return_to=<path>: signs in, then 302 to that path
 *     POST  /api/auth/sign-out     {next}: signed out; the page goes to next
 *     POST  /api/session           {"tenant_id"}: Session in that company (the demo has one)
 *     PATCH /api/account           {"name"?, "locale"?}: Session, kept while the server runs
 *     GET   /api/members           {members}, the company's
 *     *     /api/v0/...            the engine's HTTP API, as the signed-in member
 *     GET   /api/demo/people       {people}: whom to act as, with their team and role
 *     POST  /api/demo/act-as       {"member"}: Session, as that person
 *     *     /api/demo/updates/...  the demo's upstream edits (updates.ts), when pnpm demo runs it
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "yaml";
import {
  type AccountChange,
  accountChange,
  membersOf,
  type People,
  type Person,
  type Session,
  sessionOf,
} from "./people.ts";
import type { Updates } from "./updates.ts";

const COOKIE = "inspiration_member";
const MAX_BODY = 64 * 1024;

/** The people file: a tenant ID and at least one person, each with a member ID and a name. */
export function loadPeople(path: string): People {
  const raw = parse(readFileSync(path, "utf8")) as Partial<People> | null;
  const people = raw?.people ?? [];
  const valid = (p: Person) =>
    typeof p?.member === "string" && p.member.startsWith("mem_") && typeof p.name === "string";
  if (typeof raw?.tenant !== "string" || people.length === 0 || !people.every(valid)) {
    throw new RangeError(`${path} does not name a tenant and its people`);
  }
  return { tenant: raw.tenant, people };
}

/** A path on this site to go back to after signing in; anything else, as //evil.example, is home. */
export function returnTo(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

/** Connect-style middleware: answers /api/, passes everything else on. */
export function backend(options: People & { engine: string; updates?: Updates }) {
  const { engine, updates } = options;
  const people: People = { tenant: options.tenant, people: options.people };
  const changes = new Map<string, AccountChange>();
  const signedIn = (req: IncomingMessage): Person | undefined => {
    const member = cookie(req, COOKIE);
    return people.people.find((p) => p.member === member);
  };
  const headersOf = (person: Person) => ({
    "content-type": "application/json",
    "x-inspiration-tenant": people.tenant,
    "x-inspiration-member": person.member,
  });
  // The company's name is the engine's, read once it answers.
  let company: string | undefined;
  const companyName = async (): Promise<string> => {
    if (company) return company;
    const answer = await fetch(`${engine}/v0/spaces`, { headers: headersOf(people.people[0] as Person) });
    company = answer.ok ? ((await answer.json()) as { tenant?: { name?: string } }).tenant?.name : undefined;
    return company ?? "";
  };
  const session = async (person: Person): Promise<Session> =>
    sessionOf(people, person, await companyName(), changes.get(person.member));
  const signIn = (res: ServerResponse, person: Person) =>
    res.setHeader("set-cookie", `${COOKIE}=${person.member}; Path=/; HttpOnly; SameSite=Lax`);
  // The engine's answer as it is: the status, and the body, which is JSON.
  const forward = async (
    res: ServerResponse,
    path: string,
    person: Person,
    method = "GET",
    body?: Uint8Array<ArrayBuffer>,
  ) => {
    const answer = await fetch(`${engine}${path}`, { method, headers: headersOf(person), ...(body && { body }) });
    res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  };

  // The business backend's routes for whoever is signed in; false for any other route.
  const accountRoute = async (route: string, req: IncomingMessage, res: ServerResponse, person: Person) => {
    switch (route) {
      case "GET /api/session":
        send(res, 200, await session(person));
        return true;
      case "POST /api/session": {
        const { tenant_id } = (await json(req)) as { tenant_id?: unknown };
        if (tenant_id !== people.tenant) send(res, 404, error("not_found", "not a company of this account"));
        else send(res, 200, await session(person));
        return true;
      }
      case "PATCH /api/account": {
        let change: AccountChange;
        try {
          change = accountChange(await json(req));
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
          send(res, 400, error("bad_request", e.message));
          return true;
        }
        changes.set(person.member, { ...changes.get(person.member), ...change });
        send(res, 200, await session(person));
        return true;
      }
      case "GET /api/members":
        send(res, 200, { members: membersOf(people) });
        return true;
      default:
        return false;
    }
  };
  // What only the demo has: acting as another person, and its upstream edits.
  const demoRoute = async (url: URL, req: IncomingMessage, res: ServerResponse, person: Person) => {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/demo/people") {
      send(res, 200, { people: people.people });
      return true;
    }
    if (route === "POST /api/demo/act-as") {
      const { member } = (await json(req)) as { member?: unknown };
      const next = people.people.find((p) => p.member === member);
      if (!next) send(res, 400, error("bad_request", "no such person in this company"));
      else {
        signIn(res, next);
        send(res, 200, await session(next));
      }
      return true;
    }
    if (route === "GET /api/demo/updates") {
      send(res, 200, { updates: (await updates?.list()) ?? [] });
      return true;
    }
    const put = url.pathname.match(/^\/api\/demo\/updates\/([^/]+)$/);
    if (!put?.[1] || req.method !== "POST" || !updates) return false;
    const update = await updates.apply(decodeURIComponent(put[1]));
    const sync = `/v0/sources/${encodeURIComponent(update.source)}/sync`;
    await forward(res, sync, person, "POST", new TextEncoder().encode("{}"));
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /api/auth/sign-in") {
        signIn(res, people.people[0] as Person);
        res.writeHead(302, { location: returnTo(url.searchParams.get("return_to")) });
        return void res.end();
      }
      if (route === "POST /api/auth/sign-out") {
        // The identity provider's sign-out would come next; here there is none, so home.
        res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return send(res, 200, { next: `http://${req.headers.host ?? "localhost"}/` });
      }
      const person = signedIn(req);
      if (!person) return send(res, 401, error("unauthenticated", "sign in first"));
      if ((await accountRoute(route, req, res, person)) || (await demoRoute(url, req, res, person))) return;
      if (!url.pathname.startsWith("/api/v0/")) return send(res, 404, error("not_found", "no route"));
      const sent = req.method === "POST" ? new Uint8Array(await body(req)) : undefined;
      await forward(res, `${url.pathname.slice("/api".length)}${url.search}`, person, req.method, sent);
    } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, error("bad_request", e.message));
      if (e instanceof RangeError) return send(res, 404, error("not_found", e.message));
      send(res, 502, error("internal", `the engine at ${engine} did not answer`));
    }
  };
}

/** A JSON body; a body that is not JSON raises SyntaxError, which answers 400. */
async function json(req: IncomingMessage): Promise<unknown> {
  const text = (await body(req)).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new SyntaxError(`body over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const error = (code: string, message: string) => ({ error: { code, message } });

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
