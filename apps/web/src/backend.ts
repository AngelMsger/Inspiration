/**
 * The web app's backend as the development server runs it, standing in for the business
 * backend (apps/business) with the same browser API over one demo company (people.yaml).
 * There is no identity provider here: signing in, or signing up, signs in as the company's
 * first person, and a cookie remembers who is signed in. Every call under /api/v0/ goes on to
 * the engine's HTTP API as that member, in the engine's development identity headers. The
 * page cannot name a member itself: the backend builds the headers it forwards, so identity
 * headers from the browser never reach the engine. A call that acts in a company names the one
 * its frame shows (x-inspiration-company); naming another than the session's answers 409
 * conflict, as the business backend does. Roles, members who leave and invite links are kept
 * while the server runs (company.ts); someone who left has no company until they join by a
 * link. Under /api/demo/ are what only the demo has: acting as another person of the company,
 * and its upstream edits.
 *
 *     GET    /api/session              Session, or 401 when signed out
 *     GET    /api/auth/sign-in         ?return_to=<path>: signs in, then 302 to that path
 *     POST   /api/auth/sign-out        {next}: signed out; the page goes to next
 *     POST   /api/session              {"tenant_id"}: Session in that company (the demo has one)
 *     PATCH  /api/account              {"name"?, "locale"?}: Session, kept while the server runs
 *     GET    /api/members              MemberList, the company's
 *     PUT    /api/members/<mem>/role   {"role"}: the member, by a super admin; 409 for the last one
 *     DELETE /api/members/<mem>        204: the member leaves, by a super admin
 *     GET    /api/invites              InviteList, the links still open, for a super admin
 *     POST   /api/invites              201 InviteLink: a new link, shown this once
 *     DELETE /api/invites/<inv>        204: the link is revoked
 *     GET    /api/tokens               AccessTokenList, the member's; ?all=true every member's, for a super admin
 *     POST   /api/tokens               201 CreatedAccessToken: a new token, its secret shown this once
 *     DELETE /api/tokens/<tok>         204: the token is revoked, by its member or a super admin
 *     GET    /api/join/<code>          JoinPreview, for anyone holding the link
 *     POST   /api/join/<code>          Session, in the company the link joins
 *     *      /api/v0/...               the engine's HTTP API, as the signed-in member, with any
 *                                      body and its type, Idempotency-Key and file time the page
 *                                      sends; a file into a space's uploads up to 50 MiB
 *     GET    /api/demo/people          {people}: whom to act as, with their team and role
 *     POST   /api/demo/act-as          {"member"}: Session, as that person
 *     *      /api/demo/updates/...     the demo's upstream edits (updates.ts), when pnpm demo runs it
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ContractError, parseAs } from "@inspiration/contracts";
import type {
  AccountChange,
  NewAccessToken,
  RoleChange,
  Session,
  SwitchCompany,
} from "@inspiration/contracts/business";
import { parse } from "yaml";
import { Company, Refused } from "./company.ts";
import type { People, Person } from "./people.ts";
import type { Updates } from "./updates.ts";
import { MAX_FILE } from "./uploads.ts";

const COOKIE = "inspiration_member";
const MAX_BODY = 64 * 1024;
/** A file uploaded into a space may be as large as the engine takes (MAX_FILE). */
const FILE_ROUTE = /^\/api\/v0\/spaces\/[^/]+\/files\//;

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
  const company = new Company(people);
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
  let name: string | undefined;
  const companyName = async (): Promise<string> => {
    if (name) return name;
    const answer = await fetch(`${engine}/v0/spaces`, { headers: headersOf(people.people[0] as Person) });
    name = answer.ok ? ((await answer.json()) as { tenant?: { name?: string } }).tenant?.name : undefined;
    return name ?? "";
  };
  const session = async (person: Person): Promise<Session> =>
    company.sessionOf(person, await companyName(), changes.get(person.member));
  const signIn = (res: ServerResponse, person: Person) =>
    res.setHeader("set-cookie", `${COOKIE}=${person.member}; Path=/; HttpOnly; SameSite=Lax`);
  // The engine's answer as it is: the status, and the body, which is JSON.
  const forward = async (
    res: ServerResponse,
    path: string,
    person: Person,
    method = "GET",
    sent?: Uint8Array<ArrayBuffer>,
    extra: Record<string, string> = {},
  ) => {
    const headers = { ...headersOf(person), ...extra };
    const answer = await fetch(`${engine}${path}`, { method, headers, ...(sent && { body: sent }) });
    res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  };

  // A call under /api/v0/ as the page made it: its method, its body with its type, its
  // Idempotency-Key, and when a file was last changed. A file may be larger than other bodies.
  const forwardCall = async (url: URL, req: IncomingMessage, res: ServerResponse, person: Person) => {
    const max = FILE_ROUTE.test(url.pathname) ? MAX_FILE : MAX_BODY;
    const sent = req.method === "GET" ? undefined : new Uint8Array(await body(req, max));
    const extra: Record<string, string> = {};
    for (const name of ["idempotency-key", "content-type", "x-inspiration-modified"]) {
      const value = req.headers[name];
      if (typeof value === "string") extra[name] = value;
    }
    const path = `${url.pathname.slice("/api".length)}${url.search}`;
    await forward(res, path, person, req.method, sent, extra);
  };

  // The business backend's routes for whoever is signed in; false for any other route.
  const accountRoute = async (route: string, req: IncomingMessage, res: ServerResponse, person: Person) => {
    switch (route) {
      case "GET /api/session":
        send(res, 200, await session(person));
        return true;
      case "POST /api/session": {
        const { tenant_id } = parseAs<SwitchCompany>("SwitchCompany", await json(req));
        if (tenant_id !== people.tenant) send(res, 404, error("not_found", "not a company of this account"));
        else send(res, 200, await session(person));
        return true;
      }
      case "PATCH /api/account": {
        const change = parseAs<AccountChange>("AccountChange", await json(req));
        changes.set(person.member, { ...changes.get(person.member), ...change });
        send(res, 200, await session(person));
        return true;
      }
      default:
        return false;
    }
  };
  // The company's members, invite links and access tokens, and joining it by a link.
  const companyRoute = async (url: URL, req: IncomingMessage, res: ServerResponse, person: Person) => {
    const route = `${req.method} ${url.pathname}`;
    const [, kind, id, role] =
      url.pathname.match(/^\/api\/(members|invites|tokens|join)(?:\/([^/]+)(\/role)?)?$/) ?? [];
    const named = decodeURIComponent(id ?? "");
    const site = `http://${req.headers.host ?? "localhost"}`;
    if (route === "GET /api/members") send(res, 200, { members: company.members() });
    else if (route === "GET /api/tokens") {
      send(res, 200, company.tokens(person, `${site}/mcp`, url.searchParams.get("all") === "true"));
    } else if (route === "POST /api/tokens") {
      send(res, 201, company.createToken(person, parseAs<NewAccessToken>("NewAccessToken", await json(req))));
    } else if (kind === "tokens" && id && req.method === "DELETE") {
      company.revokeToken(person, named);
      send(res, 204);
    } else if (route === "GET /api/invites") send(res, 200, company.invites(person));
    else if (route === "POST /api/invites") {
      send(
        res,
        201,
        company.invite(person, (code) => `${site}/join/${code}`),
      );
    } else if (kind === "members" && id && role && req.method === "PUT") {
      send(res, 200, company.setRole(person, named, parseAs<RoleChange>("RoleChange", await json(req)).role));
    } else if (kind === "members" && id && !role && req.method === "DELETE") {
      company.remove(person, named);
      send(res, 204);
    } else if (kind === "invites" && id && req.method === "DELETE") {
      company.revoke(person, named);
      send(res, 204);
    } else if (kind === "join" && id && req.method === "POST") {
      company.join(person, named);
      send(res, 200, await session(person));
    } else return false;
    return true;
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
      const code = url.pathname.match(/^\/api\/join\/([^/]+)$/)?.[1];
      if (req.method === "GET" && code)
        return send(res, 200, company.preview(decodeURIComponent(code), await companyName()));
      const person = signedIn(req);
      if (!person) return send(res, 401, error("unauthenticated", "sign in first"));
      const named = req.headers["x-inspiration-company"];
      if (named !== undefined && named !== people.tenant) {
        return send(res, 409, error("conflict", "the session works in another company"));
      }
      if (await accountRoute(route, req, res, person)) return;
      // Someone who left has an account, but no company to act in until they join again.
      const outside = !company.isMember(person) && !code && route !== "POST /api/demo/act-as";
      if (outside) return send(res, 400, error("bad_request", "no current company"));
      if ((await companyRoute(url, req, res, person)) || (await demoRoute(url, req, res, person))) return;
      if (!url.pathname.startsWith("/api/v0/")) return send(res, 404, error("not_found", "no route"));
      await forwardCall(url, req, res, person);
    } catch (e) {
      if (e instanceof Refused) return send(res, e.status, error(e.code, e.message));
      const refused = e instanceof SyntaxError || e instanceof ContractError;
      if (refused) return send(res, 400, error("bad_request", e.message));
      if (e instanceof RangeError) return send(res, 404, error("not_found", e.message));
      send(res, 502, error("internal", `the engine at ${engine} did not answer`));
    }
  };
}

/** A JSON body; a body that is not JSON raises SyntaxError, which answers 400, as a ContractError does. */
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

/** A body of at most `max` bytes; a larger one is read to its end, so the page hears the answer. */
async function body(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) throw new Refused(413, "too_large", `body over ${max} bytes`);
  return Buffer.concat(chunks);
}

const error = (code: string, message: string) => ({ error: { code, message } });

/** An answer: JSON, or no body for 204. */
function send(res: ServerResponse, status: number, value?: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}
