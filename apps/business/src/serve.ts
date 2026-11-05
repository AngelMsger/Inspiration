#!/usr/bin/env node
/**
 * inspiration-business serve [--port 4200] [--web <dir>]
 *
 * Runs the business backend (index.ts) on localhost, behind the site's TLS proxy. It migrates
 * the accounts and tenancy schemas, sends every company and member to the engine again (so
 * the engine's copy catches up with any call that failed), and serves the browser API, the
 * JWKS the engine checks its tokens with, and, with --web, the built web app.
 *
 * Settings come from the environment, or a .env file in the working directory:
 *
 *     INSPIRATION_DATABASE_URL       Postgres, as for the engine (kernel settings)
 *     INSPIRATION_PUBLIC_URL         this site as the browser reaches it; the tokens' issuer (http://localhost:4200)
 *     INSPIRATION_ENGINE_URL         where the engine's HTTP API answers (http://127.0.0.1:4100)
 *     INSPIRATION_ENGINE_AUDIENCE    the engine's --audience (INSPIRATION_ENGINE_URL)
 *     INSPIRATION_LOGTO_ISSUER       Logto's OIDC issuer, such as http://localhost:3001/oidc
 *     INSPIRATION_LOGTO_APP_ID       the ID and secret of Logto's "Traditional web" application
 *     INSPIRATION_LOGTO_APP_SECRET
 *     INSPIRATION_SIGNING_KEY        the Ed25519 private key tokens are signed with, PKCS#8 PEM
 *     INSPIRATION_SIGNING_KEY_ID     its kid, a new one whenever the key changes
 *
 * Without a signing key, one is made at start, for development: the engine fetches the JWKS
 * again when it meets the new kid. Logto's redirect URI is <public URL>/api/auth/callback and
 * its post sign-out redirect URI <public URL>/.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs, parseEnv } from "node:util";
import { MIGRATIONS as ACCOUNTS, Accounts, OidcProvider, PostgresAccounts } from "@inspiration/accounts";
import {
  applyMigrations,
  generateSigningKey,
  getSettings,
  logger,
  openPool,
  signingKeyFromPem,
} from "@inspiration/kernel";
import { PostgresTenancy, MIGRATIONS as TENANCY, Tenancy } from "@inspiration/tenancy";
import { EngineClient } from "./engine.ts";
import { backendHandler } from "./routes.ts";
import { Tokens } from "./tokens.ts";

const log = logger("business.serve");

const USAGE = "usage: inspiration-business serve [--port 4200] [--web <dir>]";

/** The settings above, from the environment over .env. */
function settingsOf(env: Record<string, string | undefined>) {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new RangeError(`set ${name} (see inspiration-business --help)`);
    return value;
  };
  const publicUrl = (env.INSPIRATION_PUBLIC_URL || "http://localhost:4200").replace(/\/$/, "");
  const engineUrl = env.INSPIRATION_ENGINE_URL || "http://127.0.0.1:4100";
  const pem = env.INSPIRATION_SIGNING_KEY;
  return {
    publicUrl,
    engineUrl,
    audience: env.INSPIRATION_ENGINE_AUDIENCE || engineUrl,
    logto: {
      issuer: need("INSPIRATION_LOGTO_ISSUER"),
      clientId: need("INSPIRATION_LOGTO_APP_ID"),
      clientSecret: need("INSPIRATION_LOGTO_APP_SECRET"),
      redirectUri: `${publicUrl}/api/auth/callback`,
      signedOutUri: `${publicUrl}/`,
    },
    key: pem ? signingKeyFromPem(pem, need("INSPIRATION_SIGNING_KEY_ID")) : undefined,
  };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: "4200" }, web: { type: "string" }, help: { type: "boolean" } },
  });
  if (positionals[0] !== "serve" || values.help) {
    console.error(USAGE);
    return 2;
  }
  const file = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
  const settings = settingsOf({ ...file, ...process.env });
  const key = settings.key ?? generateSigningKey(`dev-${Date.now()}`);
  if (!settings.key) log.warn("no INSPIRATION_SIGNING_KEY: signing with a key made for this run", { kid: key.kid });

  const { databaseUrl } = getSettings();
  await applyMigrations(databaseUrl, [ACCOUNTS, TENANCY]);
  const pool = await openPool(databaseUrl);
  const tokens = new Tokens({ issuer: settings.publicUrl, audience: settings.audience, key });
  const engine = new EngineClient(settings.engineUrl, tokens);
  const accounts = new Accounts(new PostgresAccounts(pool), new OidcProvider(settings.logto));
  const tenancy = new Tenancy(new PostgresTenancy(pool), engine);

  const server = createServer(
    backendHandler({
      accounts,
      tenancy,
      engine,
      tokens,
      publicUrl: settings.publicUrl,
      ...(values.web && { webDir: values.web }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(Number(values.port), "127.0.0.1", resolve));
  log.info("listening", { port: (server.address() as AddressInfo).port, public: settings.publicUrl });
  // The engine reads this backend's JWKS to check the provisioning tokens, so it is sent after listening.
  tenancy.resync().catch((error: unknown) => log.warn("the engine's copy was not brought up to date", { error }));

  const stop = () => {
    server.close();
    void pool.end().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof RangeError ? error.message : error);
      process.exit(1);
    },
  );
}
