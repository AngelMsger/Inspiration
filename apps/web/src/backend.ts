/**
 * The web app's backend as the development server runs it, standing in for the business
 * layer's backend for the frontend until that exists. It signs nobody in: a person picks whom
 * to act as from the people of the demo tenant (people.yaml), a cookie remembers the choice,
 * and every call under /api/v0/ goes on to the engine's HTTP API with that member and tenant
 * in the engine's development identity headers. The page cannot name a member itself: the
 * backend builds the headers it forwards, so identity headers from the browser never reach
 * the engine.
 *
 *     GET  /api/session   Session: who the page acts as, and the people to pick from
 *     POST /api/session   {"member": "<mem_...>"}: act as another person of the tenant
 *     *    /api/v0/...    the engine's HTTP API, as that person
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "yaml";

/** One person of the demo tenant, as the business layer's accounts would name them. */
export interface Person {
  member: string;
  name: string;
  /** Their team and role, in the tenant's own words. */
  about?: string;
  /** The interface language they would have chosen, a BCP 47 tag. */
  locale?: string;
}

export interface People {
  tenant: string;
  people: Person[];
}

export interface Session extends People {
  person: Person;
}

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

/** Connect-style middleware: answers /api/, passes everything else on. */
export function backend(options: People & { engine: string }) {
  const { engine, tenant, people } = options;
  const personOf = (req: IncomingMessage): Person => {
    const member = cookie(req, COOKIE);
    return people.find((p) => p.member === member) ?? (people[0] as Person);
  };

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    try {
      if (url.pathname === "/api/session") {
        if (req.method === "POST") {
          const { member } = JSON.parse((await body(req)).toString("utf8") || "{}") as { member?: unknown };
          const person = people.find((p) => p.member === member);
          if (!person) return send(res, 400, error("bad_request", "no such person in this tenant"));
          res.setHeader("set-cookie", `${COOKIE}=${person.member}; Path=/; HttpOnly; SameSite=Lax`);
          return send(res, 200, { tenant, people, person } satisfies Session);
        }
        return send(res, 200, { tenant, people, person: personOf(req) } satisfies Session);
      }
      if (!url.pathname.startsWith("/api/v0/")) return send(res, 404, error("not_found", "no route"));
      const person = personOf(req);
      const forwarded = await fetch(`${engine}${url.pathname.slice("/api".length)}${url.search}`, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          "x-inspiration-tenant": tenant,
          "x-inspiration-member": person.member,
        },
        ...(req.method === "POST" && { body: new Uint8Array(await body(req)) }),
      });
      res.writeHead(forwarded.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, error("bad_request", e.message));
      send(res, 502, error("internal", `the engine at ${engine} did not answer`));
    }
  };
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
