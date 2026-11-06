// The product as the trial runs it, in this process, for the gate checks (docs/design/mvp.md):
// the business backend (apps/business) in front of the engine (apps/engine), each on its own
// port. The engine checks every principal token against the JWKS the backend serves, as it
// does in a deployment, and a stand-in identity provider signs people in. In memory, or on the
// stack: the business layer's accounts, tenancy and access grants on Postgres, the engine's
// store on Postgres and its permissions in SpiceDB. Models are the development stand-ins, so
// a check costs nothing.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeClient,
  connect,
  jwksFromUrl,
  type SpiceDBClient,
  SpiceDBGraph,
  TokenVerifier,
  writeSchema,
} from "@inspiration/access-control";
import { AccessGrants, MemoryGrants, PostgresGrants } from "@inspiration/access-grants";
import { Accounts, MemoryAccounts, PostgresAccounts, type ProviderIdentity } from "@inspiration/accounts";
import { FakeProvider } from "@inspiration/accounts/testing";
import { backendHandler, EngineClient, Tokens } from "@inspiration/business";
import { type Browser, signIn } from "@inspiration/business/testing";
import { Engine, serveApi } from "@inspiration/engine";
import { generateSigningKey, openPool, type Pool } from "@inspiration/kernel";
import { MemoryTenancy, PostgresTenancy, Tenancy } from "@inspiration/tenancy";
import { createTestDatabase, hasStack, SPICEDB_ENDPOINT, SPICEDB_KEY } from "@inspiration/testkit";
import { test } from "vitest";

/** The engine's audience, as INSPIRATION_ENGINE_AUDIENCE and the engine's --audience name it. */
const AUDIENCE = "https://engine.inspiration.test";

export const BACKENDS = [
  { backend: "memory", skip: false },
  { backend: "stack", skip: !hasStack() },
] as const;
export type Backend = (typeof BACKENDS)[number]["backend"];

export interface Site {
  /** The site as the browser reaches it: the business backend. */
  url: string;
  engine: Engine;
  /** The backend's principal tokens, to call the engine as the backend would. */
  tokens: Tokens;
  /** Where the engine's HTTP API answers. */
  engineUrl: string;
  /** A browser signed in as who, through the provider's redirect and back. */
  signIn(who: ProviderIdentity): Promise<Browser>;
  /** Take the engine's API down, as when it restarts: the backend answers 502 meanwhile. */
  stopEngine(): Promise<void>;
  startEngine(): Promise<void>;
  close(): Promise<void>;
}

const listen = async (server: Server, port = 0) => {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const closed = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/** The stores of each layer: the doubles, or Postgres and SpiceDB. */
async function storesOf(databaseUrl?: string) {
  if (!databaseUrl) {
    return {
      accounts: new MemoryAccounts(),
      tenancy: new MemoryTenancy(),
      grants: new MemoryGrants(),
      engine: {},
      close: async () => {},
    };
  }
  const pool: Pool = await openPool(databaseUrl);
  const spicedb: SpiceDBClient = connect(SPICEDB_ENDPOINT, SPICEDB_KEY, { insecure: true });
  // Tenants, members and spaces get new IDs on every run, so runs share one SpiceDB.
  await writeSchema(spicedb);
  return {
    accounts: new PostgresAccounts(pool),
    tenancy: new PostgresTenancy(pool),
    grants: new PostgresGrants(pool),
    engine: { databaseUrl, graph: new SpiceDBGraph(spicedb) },
    close: async () => {
      closeClient(spicedb);
      await pool.end();
    },
  };
}

/** Start the site: in memory, or on the stack when given the database a test owns. */
export async function startSite(databaseUrl?: string): Promise<Site> {
  const stores = await storesOf(databaseUrl);
  const blobDir = await mkdtemp(join(tmpdir(), "inspiration-site-"));
  // The backend listens first: its URL is the tokens' issuer and where the engine reads its keys.
  let handle: RequestListener = (_req, res) => res.writeHead(503).end();
  const site = createServer((req, res) => handle(req, res));
  const url = `http://127.0.0.1:${await listen(site)}`;

  const engine = await Engine.open({ blobDir, ...stores.engine });
  const verifier = new TokenVerifier({
    issuer: url,
    audience: AUDIENCE,
    keys: jwksFromUrl(`${url}/.well-known/jwks.json`),
  });
  const api = await serveApi(engine, 0, { tokens: verifier });
  const enginePort = (api.address() as AddressInfo).port;
  const engineUrl = `http://127.0.0.1:${enginePort}`;

  const tokens = new Tokens({ issuer: url, audience: AUDIENCE, key: generateSigningKey("site-1") });
  const client = new EngineClient(engineUrl, tokens);
  const provider = new FakeProvider();
  handle = backendHandler({
    accounts: new Accounts(stores.accounts, provider),
    tenancy: new Tenancy(stores.tenancy, client),
    grants: new AccessGrants(stores.grants),
    engine: client,
    tokens,
    publicUrl: url,
  });

  return {
    url,
    engine,
    tokens,
    engineUrl,
    signIn: (who) => signIn(url, provider, who),
    stopEngine: () => closed(api),
    startEngine: async () => void (await listen(api, enginePort)),
    async close() {
      await Promise.all([closed(site), api.listening ? closed(api) : undefined]);
      await engine.close();
      await stores.close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

/** A test with a fresh site of the backend's kind, closed after it; on the stack, in a database of its own. */
export function siteTest(backend: Backend) {
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  return test.extend("site", async ({}, { onCleanup }) => {
    const db = backend === "stack" ? await createTestDatabase() : undefined;
    const site = await startSite(db?.url);
    onCleanup(async () => {
      await site.close();
      await db?.drop();
    });
    return site;
  });
}
