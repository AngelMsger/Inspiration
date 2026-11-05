#!/usr/bin/env node
/**
 * inspiration-engine serve <corpus> (--issuer <url> --audience <url> [--jwks <url|file>] | --dev-identity)
 *     [--port 4100] [--today <YYYY-MM-DD>] [--gateway <file> [--valkey <url>]]
 *
 * Runs the engine in memory over a corpus and serves its HTTP API (http.ts) on localhost, for
 * the web app to read. The corpus stands in for the business layer: it provisions the tenant,
 * its spaces and members, and its sources are synced once at start and read to the end (every
 * event delivered, topics clustered and given owners) before the API answers. Models are the development
 * stand-ins of config/gateway.dev.yaml, or those of the --gateway file, as when the demo is
 * recorded with real answers (config/gateway.demo.yaml); a config that keeps its replies in
 * Valkey takes the server from --valkey. --today sets the day governance and freshness take as
 * now; without it, the real day.
 *
 * Requests carry principal tokens the business layer signs for --issuer and --audience, checked
 * against its keys at --jwks: a URL (by default <issuer>/.well-known/jwks.json, since the engine may
 * reach the business layer on another host than the public issuer URL) or a JWKS file. For
 * development, --dev-identity also takes the x-inspiration-tenant and x-inspiration-member
 * headers instead (the demo and its snapshot run so).
 */

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Jwks, jwksFromUrl, staticKeys, TokenVerifier } from "@inspiration/access-control";
import { logger } from "@inspiration/kernel";
import { Gateway, loadGatewayConfig, ValkeyCache } from "@inspiration/model-gateway";
import { Corpus } from "./corpus.ts";
import { Engine } from "./engine.ts";
import { type Identity, serveApi } from "./http.ts";
import { assignOwners } from "./owners.ts";

const log = logger("engine.serve");

/** Provision the corpus, sync every source, read it all and give its topics owners, as the demo starts. */
export async function seed(engine: Engine, corpus: Corpus): Promise<void> {
  await corpus.provision(engine.authz);
  await corpus.stamp();
  for (const source of corpus.sources) {
    await engine.sync.addSource(source);
    await engine.sync.sync(source.id, { via: "reconcile" });
  }
  await engine.settle();
  await engine.topics.recluster(corpus.tenantId);
  await engine.settle();
  await assignOwners(engine, corpus);
  await engine.settle();
}

/** The gateway a --gateway file configures, with its Valkey response cache when it keeps one. */
async function gatewayOf(
  file: string,
  valkeyUrl: string | undefined,
): Promise<{ gateway: Gateway; close(): Promise<void> }> {
  const config = loadGatewayConfig(file);
  if (config.cache.backend !== "valkey") {
    const gateway = await Gateway.create(config);
    return { gateway, close: () => gateway.close() };
  }
  if (!valkeyUrl) throw new RangeError(`${file} keeps its response cache in Valkey: give --valkey`);
  const cache = ValkeyCache.fromUrl(valkeyUrl);
  const gateway = await Gateway.create(config, { cache });
  return { gateway, close: () => gateway.close().then(() => cache.close()) };
}

/** Tokens when an issuer and audience are given, the development headers when asked; undefined when neither. */
function identityOf(values: {
  issuer?: string;
  audience?: string;
  jwks?: string;
  "dev-identity"?: boolean;
}): Identity | undefined {
  const devHeaders = values["dev-identity"] === true;
  if (!values.issuer || !values.audience) return devHeaders ? { devHeaders } : undefined;
  const jwks = values.jwks ?? `${values.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const keys = /^https?:\/\//.test(jwks)
    ? jwksFromUrl(jwks)
    : staticKeys(JSON.parse(readFileSync(jwks, "utf8")) as Jwks);
  return { tokens: new TokenVerifier({ issuer: values.issuer, audience: values.audience, keys }), devHeaders };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4100" },
      today: { type: "string" },
      gateway: { type: "string" },
      valkey: { type: "string" },
      issuer: { type: "string" },
      audience: { type: "string" },
      jwks: { type: "string" },
      "dev-identity": { type: "boolean", default: false },
    },
  });
  const [command, dir] = positionals;
  const identity = identityOf(values);
  if (command !== "serve" || !dir || !identity) {
    console.error(
      "usage: inspiration-engine serve <corpus> (--issuer <url> --audience <url> [--jwks <url|file>] | --dev-identity)" +
        " [--port 4100] [--today YYYY-MM-DD] [--gateway <file> [--valkey <url>]]",
    );
    return 2;
  }
  const corpus = await Corpus.load(dir);
  const today = values.today ? new Date(`${values.today}T09:00:00Z`) : undefined;
  const models = values.gateway ? await gatewayOf(values.gateway, values.valkey) : undefined;
  const engine = await Engine.open({
    blobDir: await mkdtemp(join(tmpdir(), "inspiration-blobs-")),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(today && { clock: () => today }),
    ...(models && { models: models.gateway }),
  });
  const started = performance.now();
  await seed(engine, corpus);
  log.info("corpus read", { corpus: dir, seconds: Math.round((performance.now() - started) / 100) / 10 });
  const server = await serveApi(
    engine,
    {
      tenant: (id) => (id === corpus.tenantId ? corpus.tenant : undefined),
      spaces: (id) => (id === corpus.tenantId ? corpus.spaces : []),
    },
    Number(values.port),
    identity,
  );
  const stop = () => {
    server.close();
    void engine
      .close()
      .then(() => models?.close())
      .then(() => process.exit(0));
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
      console.error(error);
      process.exit(1);
    },
  );
}
