import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Accounts, MemoryAccounts, type ProviderIdentity } from "@inspiration/accounts";
import { FakeProvider } from "@inspiration/accounts/testing";
import { type Ed25519Jwk, generateSigningKey, publicKeyOf, verifyJwt } from "@inspiration/kernel";
import { MemoryTenancy, type SampleCompany, Tenancy } from "@inspiration/tenancy";
import { backendHandler, EngineClient, SESSION_COOKIE, Tokens } from "../src/index.ts";

export const PUBLIC_URL = "https://inspiration.example";
export const ENGINE_AUDIENCE = "https://engine.example";

/** The sample company the test site offers. */
export const SAMPLE: SampleCompany = {
  id: "ten_01SAMPLE00000000000000000001",
  name: "Hengyuan",
  default_locale: "zh-CN",
};

export const ZHOU: ProviderIdentity = {
  subject: "idp-zhou",
  email: "zhou@example.com",
  email_verified: true,
  name: "Zhou",
};
export const ZHANG: ProviderIdentity = {
  subject: "idp-zhang",
  email: "zhang@example.com",
  email_verified: true,
  name: "Zhang",
};

export interface EngineCall {
  method: string;
  path: string;
  claims: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  body: string;
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/**
 * The engine as the backend meets it: it checks every token against the backend's JWKS, as
 * the engine's verifier does, records the call, and answers each write with a consistency
 * token. While down, it refuses everything with 503.
 */
export class FakeEngine {
  readonly calls: EngineCall[] = [];
  down = false;
  url = "";
  readonly #server: Server;

  constructor(jwks: () => { keys: Ed25519Jwk[] }) {
    this.#server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const { payload } = await verifyJwt(token, async (kid) => {
        const jwk = jwks().keys.find((k) => k.kid === kid);
        return jwk && publicKeyOf(jwk);
      }).catch(() => ({ payload: undefined }));
      const fresh = payload && Number(payload.exp) - Number(payload.iat) <= 5 * 60;
      if (!fresh || payload.iss !== PUBLIC_URL || payload.aud !== ENGINE_AUDIENCE) {
        return reply(401, { error: { code: "unauthenticated", message: "bad token" } });
      }
      const call = {
        method: req.method ?? "",
        path: req.url ?? "",
        claims: payload,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      this.calls.push(call);
      if (this.down) return reply(503, { error: { code: "internal", message: "down" } });
      if (call.method === "GET") return reply(200, { spaces: [] });
      reply(200, { echo: call.body, consistency_token: `ct-${this.calls.length}` });
    });
  }

  static async start(jwks: () => { keys: Ed25519Jwk[] }): Promise<FakeEngine> {
    const engine = new FakeEngine(jwks);
    engine.url = await listen(engine.#server);
    return engine;
  }

  /** The calls to paths that start with prefix. */
  to(prefix: string): EngineCall[] {
    return this.calls.filter((c) => c.path.startsWith(prefix));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

/** A browser on the backend's site: it keeps the cookies it is sent and never follows redirects. */
export class Browser {
  readonly base: string;
  readonly cookies = new Map<string, string>();

  constructor(base: string) {
    this.base = base;
  }

  /** The session cookie's value, while signed in. */
  get session(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }

  /** A call to the site, its body sent as JSON, or as it is when bytes; the answer's body is read as T, which the test names. */
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const bytes = body instanceof Uint8Array;
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookies.size && { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
        ...(body !== undefined && !bytes && { "content-type": "application/json" }),
        ...headers,
      },
      ...(body !== undefined && { body: bytes ? body : JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const [name = "", value = ""] = (set.split(";")[0] ?? "").split("=");
      if (/Max-Age=0(;|$)/.test(set)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    const json: unknown = res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text;
    return { status: res.status, body: json as T, headers: res.headers };
  }
}

export interface Backend {
  url: string;
  provider: FakeProvider;
  engine: FakeEngine;
  tenancy: Tenancy;
  /** A new browser on the site, signed out. */
  browser(): Browser;
  /** A browser signed in as who, through the provider's redirect and back. */
  signIn(who: ProviderIdentity): Promise<Browser>;
  close(): Promise<void>;
}

export async function startBackend(options: { webDir?: string } = {}): Promise<Backend> {
  const provider = new FakeProvider();
  const tokens = new Tokens({ issuer: PUBLIC_URL, audience: ENGINE_AUDIENCE, key: generateSigningKey("test-1") });
  const engine = await FakeEngine.start(() => tokens.jwks());
  const client = new EngineClient(engine.url, tokens);
  const tenancy = new Tenancy(new MemoryTenancy(), client, { sample: SAMPLE });
  const server = createServer(
    backendHandler({
      accounts: new Accounts(new MemoryAccounts(), provider),
      tenancy,
      engine: client,
      tokens,
      publicUrl: PUBLIC_URL,
      ...options,
    }),
  );
  const url = await listen(server);
  const browser = () => new Browser(url);
  return {
    url,
    provider,
    engine,
    tenancy,
    browser,
    async signIn(who) {
      const b = browser();
      await b.call("GET", "/api/auth/sign-in");
      const { code, state } = provider.code(who);
      const back = await b.call("GET", `/api/auth/callback?${new URLSearchParams({ code, state })}`);
      if (back.status !== 302 || !b.session) throw new Error(`sign-in failed: ${back.headers.get("location")}`);
      return b;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.close();
    },
  };
}
