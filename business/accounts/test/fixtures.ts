import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { type AccountsStore, MemoryAccounts, PostgresAccounts } from "../src/index.ts";

export { FakeProvider } from "../src/testing.ts";

export const BACKENDS = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
] as const;

export const storeTest = (backend: (typeof BACKENDS)[number]["backend"]) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("store", async ({}, { onCleanup }): Promise<AccountsStore> => {
    if (backend === "memory") return new MemoryAccounts();
    const db = await createTestDatabase();
    const pool = await openPool(db.url);
    onCleanup(async () => {
      await pool.end();
      await db.drop();
    });
    return new PostgresAccounts(pool);
  });

/** An OpenID provider on localhost: discovery, keys, and a token endpoint that answers a set ID token. */
export class TestIssuer {
  readonly server: Server;
  readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  issuer = "";
  /** The token endpoint's last request, as form fields, with its authorization header. */
  lastToken?: { form: URLSearchParams; authorization?: string };
  /** Claims of the next ID token; the issuer and audience default to this provider and "web". */
  claims: Record<string, unknown> = {};
  kid = "key-1";
  signWith?: KeyObject;

  private constructor() {
    this.key = generateKeyPairSync("ec", { namedCurve: "P-384" });
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", this.issuer);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/oidc/.well-known/openid-configuration") {
        return send(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/auth`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          end_session_endpoint: `${this.issuer}/session/end`,
        });
      }
      if (url.pathname === "/oidc/jwks") {
        return send(200, { keys: [{ ...this.key.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "ES384" }] });
      }
      if (url.pathname === "/oidc/token" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        this.lastToken = { form: new URLSearchParams(body), authorization: req.headers.authorization };
        return send(200, { access_token: "at", token_type: "Bearer", id_token: this.idToken() });
      }
      send(404, {});
    });
  }

  static async start(): Promise<TestIssuer> {
    const issuer = new TestIssuer();
    await new Promise<void>((resolve) => issuer.server.listen(0, "127.0.0.1", resolve));
    issuer.issuer = `http://127.0.0.1:${(issuer.server.address() as AddressInfo).port}/oidc`;
    return issuer;
  }

  idToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: this.issuer, aud: "web", sub: "logto-user-1", iat: now, exp: now + 3600, ...this.claims };
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${part({ alg: "ES384", typ: "JWT", kid: this.kid })}.${part(claims)}`;
    const signature = sign("sha384", Buffer.from(input), {
      key: this.signWith ?? this.key.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${signature.toString("base64url")}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
