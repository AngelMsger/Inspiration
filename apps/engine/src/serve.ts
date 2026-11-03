#!/usr/bin/env node
/**
 * inspiration-engine serve <corpus> [--port 4100] [--today <YYYY-MM-DD>]
 *
 * Runs the engine in memory over a corpus and serves its HTTP API (http.ts) on localhost, for
 * the web app to read. The corpus stands in for the business layer: it provisions the tenant,
 * its spaces and members, and its sources are synced once at start and read to the end (every
 * event delivered, topics clustered) before the API answers. Models are the development
 * stand-ins of config/gateway.dev.yaml. --today sets the day governance and freshness take as
 * now; without it, the real day.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { logger } from "@inspiration/kernel";
import { Corpus } from "./corpus.ts";
import { Engine } from "./engine.ts";
import { serveApi } from "./http.ts";

const log = logger("engine.serve");

/** Provision the corpus, sync every source and read it all, as the demo starts. */
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
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: "4100" }, today: { type: "string" } },
  });
  const [command, dir] = positionals;
  if (command !== "serve" || !dir) {
    console.error("usage: inspiration-engine serve <corpus> [--port 4100] [--today YYYY-MM-DD]");
    return 2;
  }
  const corpus = await Corpus.load(dir);
  const today = values.today ? new Date(`${values.today}T09:00:00Z`) : undefined;
  const engine = await Engine.open({
    blobDir: await mkdtemp(join(tmpdir(), "inspiration-blobs-")),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(today && { clock: () => today }),
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
    void engine.close().then(() => process.exit(0));
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
