#!/usr/bin/env node
/**
 * inspiration-engine serve <corpus> [--port 4100] [--today <YYYY-MM-DD>] [--gateway <file> [--valkey <url>]]
 *
 * Runs the engine in memory over a corpus and serves its HTTP API (http.ts) on localhost, for
 * the web app to read. The corpus stands in for the business layer: it provisions the tenant,
 * its spaces and members, and its sources are synced once at start and read to the end (every
 * event delivered, topics clustered and given owners) before the API answers. Models are the development
 * stand-ins of config/gateway.dev.yaml, or those of the --gateway file, as when the demo is
 * recorded with real answers (config/gateway.demo.yaml); a config that keeps its replies in
 * Valkey takes the server from --valkey. --today sets the day governance and freshness take as
 * now; without it, the real day.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { logger } from "@inspiration/kernel";
import { Gateway, loadGatewayConfig, ValkeyCache } from "@inspiration/model-gateway";
import { Corpus } from "./corpus.ts";
import { Engine } from "./engine.ts";
import { serveApi } from "./http.ts";
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

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4100" },
      today: { type: "string" },
      gateway: { type: "string" },
      valkey: { type: "string" },
    },
  });
  const [command, dir] = positionals;
  if (command !== "serve" || !dir) {
    console.error(
      "usage: inspiration-engine serve <corpus> [--port 4100] [--today YYYY-MM-DD] [--gateway <file> [--valkey <url>]]",
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
