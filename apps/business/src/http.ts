// What every answer of the business backend shares: errors, bodies, the session cookie, and
// the built web app's files.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ApiError, ApiErrorCode } from "@inspiration/contracts";

/** A request the backend answers with an ApiError body. */
export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Sent with every answer: no sniffing a type, no framing by another site, no full URL to other sites. */
const GUARDS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

export function sendJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  if (body === undefined) {
    res.writeHead(status, { ...GUARDS, "cache-control": "no-store", ...headers });
    res.end();
    return;
  }
  res.writeHead(status, {
    ...GUARDS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, error: HttpError): void {
  const body: ApiError = { error: { code: error.code, message: error.message } };
  sendJson(res, error.status, body);
}

/** An answer as the engine gave it, passed on to the browser. */
export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Uint8Array): void {
  res.writeHead(status, { ...GUARDS, "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, {
    ...GUARDS,
    location,
    "cache-control": "no-store",
    ...(cookies.length && { "set-cookie": cookies }),
  });
  res.end();
}

/** The request's body, refused past limit bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(400, "bad_request", `body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A JSON body of at most 64 KiB. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, 64 * 1024);
  return JSON.parse(body.toString("utf8"));
}

/**
 * Whether a request that changes something says it sends JSON. A form on another site can
 * only send form or text bodies, so it cannot make one.
 */
export function sendsJson(req: IncomingMessage): boolean {
  return /^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "");
}

export function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A cookie the page's scripts cannot read, sent to this site only and with top-level links into it. Max-Age 0 clears it. */
export function cookie(name: string, value: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A file of the built web app. A file under /assets/ has a hashed name, so it is kept for a
 * year; any other path that names no file is a page of the app, answered with index.html.
 */
export async function serveWeb(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const root = resolve(dir);
  let file = resolve(root, `.${safeDecode(pathname)}`);
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, "not_found", "no such file");
  let found = await isFile(file);
  if (!found && pathname.startsWith("/assets/")) throw new HttpError(404, "not_found", "no such file");
  if (!found) {
    file = resolve(root, "index.html");
    found = await isFile(file);
    if (!found) throw new HttpError(404, "not_found", "the web app is not built");
  }
  res.writeHead(200, {
    ...GUARDS,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "bad_request", "the path is not valid");
  }
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}
