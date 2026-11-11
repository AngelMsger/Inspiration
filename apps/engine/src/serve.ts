#!/usr/bin/env node
/**
 * inspiration-engine serve [<corpus>] (--issuer <url> --audience <url> [--jwks <url|file>] | --dev-identity)
 *     [--persistent] [--discover-facts] [--port 4100] [--today <YYYY-MM-DD>]
 *     [--gateway <file> [--corpus-gateway <file>] [--valkey <url>] [--usage <postgres url>]]
 *
 * --persistent uses the configured Postgres, Valkey, SpiceDB and blob directory; otherwise
 * runs the engine in memory. Serves its HTTP API (http.ts) on localhost. Without a corpus it
 * starts empty, and the business layer provisions its tenants and members and creates their
 * spaces over the API; being in memory, it forgets them when it stops, so provision again
 * after a restart (the drift check, GET /v0/tenants/:tenant/members, shows an empty copy).
 * With a corpus, the corpus stands in for the business layer as well: it provisions its
 * tenant, spaces and members, and its sources are synced once at start and read to the end
 * (every event delivered, topics clustered and given owners) before the API answers. Models are the development
 * stand-ins of config/gateway.dev.yaml, or those of the --gateway file, as when the demo is
 * recorded with real answers (config/gateway.demo.yaml); a config that keeps its replies in
 * Valkey takes the server from --valkey. --corpus-gateway gives the corpus's own tenant other
 * models than everyone else's, as the trial does (config/gateway.trial.yaml): the sample
 * company keeps the models its story rests on, while the companies that sign up read and
 * answer on a real model. Either way the budgets are those of --gateway, counted in one usage
 * ledger (models.ts); --usage keeps it in Postgres, and a config with a budget over a month
 * or in total needs it. --today sets the day governance and freshness take as
 * now; without it, the real day. Every RESUME_EVERY_MS it reads on the documents whose reading
 * stopped at a spent budget or a model out of reach (Engine.resumeReading).
 *
 * Requests carry principal tokens the business layer signs for --issuer and --audience, checked
 * against its keys at --jwks: a URL (by default <issuer>/.well-known/jwks.json, since the engine may
 * reach the business layer on another host than the public issuer URL) or a JWKS file. For
 * development, --dev-identity also takes the x-inspiration-tenant and x-inspiration-member
 * headers instead (the demo and its snapshot run so).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import {
  closeClient,
  connect,
  type Jwks,
  jwksFromUrl,
  SpiceDBGraph,
  staticKeys,
  TokenVerifier,
  writeSchema,
} from "@inspiration/access-control";
import { getSettings, logger } from "@inspiration/kernel";
import { connectionSecret, recoverConnections } from "./connections.ts";
import { Corpus } from "./corpus.ts";
import { Engine, RESUME_EVERY_MS } from "./engine.ts";
import { type Identity, serveApi } from "./http.ts";
import { openModels } from "./models.ts";
import { assignOwners } from "./owners.ts";
import { organizeKnowledge } from "./reading-on-use.ts";

const log = logger("engine.serve");

/** Provision the corpus, sync every source, read it all and give its topics owners, as the demo starts. */
export async function seed(engine: Engine, corpus: Corpus): Promise<void> {
  await corpus.provision(engine.directory, engine.authz);
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
      "corpus-gateway": { type: "string" },
      valkey: { type: "string" },
      usage: { type: "string" },
      issuer: { type: "string" },
      audience: { type: "string" },
      jwks: { type: "string" },
      "dev-identity": { type: "boolean", default: false },
      persistent: { type: "boolean", default: false },
      "discover-facts": { type: "boolean", default: false },
    },
  });
  const [command, dir] = positionals;
  const identity = identityOf(values);
  const corpusGateway = values["corpus-gateway"];
  if (command !== "serve" || positionals.length > 2 || !identity || (corpusGateway && (!dir || !values.gateway))) {
    console.error(
      "usage: inspiration-engine serve [<corpus>] (--issuer <url> --audience <url> [--jwks <url|file>] | --dev-identity)" +
        " [--port 4100] [--today YYYY-MM-DD] [--gateway <file> [--corpus-gateway <file>] [--valkey <url>] [--usage <url>]]",
    );
    return 2;
  }
  const corpus = dir === undefined ? undefined : await Corpus.load(dir);
  const settings = getSettings();
  const persistent = values.persistent;
  const client = persistent
    ? connect(settings.spicedbEndpoint, settings.spicedbKey, { insecure: settings.spicedbInsecure })
    : undefined;
  if (client) await writeSchema(client);
  const today = values.today ? new Date(`${values.today}T09:00:00Z`) : undefined;
  const models = values.gateway
    ? await openModels({
        gateway: values.gateway,
        ...(corpus && corpusGateway && { corpus: { gateway: corpusGateway, tenantId: corpus.tenantId } }),
        ...((values.valkey || persistent) && { valkeyUrl: values.valkey ?? settings.valkeyUrl }),
        ...((values.usage || persistent) && { usageUrl: values.usage ?? settings.databaseUrl }),
      })
    : undefined;
  const engine = await Engine.open({
    secret: connectionSecret,
    discoverFacts: values["discover-facts"],
    blobDir: persistent ? settings.blobDir : await mkdtemp(join(tmpdir(), "inspiration-blobs-")),
    ...(persistent && {
      databaseUrl: settings.databaseUrl,
      valkeyUrl: settings.valkeyUrl,
      streamPrefix: settings.streamPrefix,
    }),
    ...(client && { graph: new SpiceDBGraph(client) }),
    // The corpus's catalogue is its tenant's alone; provisioned companies have none yet.
    ...(corpus && { resolvePrincipal: corpus.resolvePrincipal, vocabulary: corpus.vocabularyOf }),
    ...(today && { clock: () => today }),
    ...(models && { models: models.models, ledger: models.ledger }),
  });
  const dirty = new Set<string>();
  if (values["discover-facts"]) {
    for (const source of await engine.sync.listSources()) dirty.add(source.tenant_id);
    engine.observe("claims.updated", "local-organization", async (event) => {
      dirty.add(event.tenant_id);
    });
  }
  let organizing = false;
  const organize = setInterval(async () => {
    if (organizing || !dirty.size) return;
    organizing = true;
    const tenants = [...dirty];
    dirty.clear();
    try {
      for (const tenant of tenants)
        await organizeKnowledge(engine, tenant).catch((error: unknown) => {
          dirty.add(tenant);
          log.warn("organizing knowledge paused", { error });
        });
    } finally {
      organizing = false;
    }
  }, 60_000);
  if (corpus) {
    const started = performance.now();
    await seed(engine, corpus);
    log.info("corpus read", { corpus: dir, seconds: Math.round((performance.now() - started) / 100) / 10 });
  } else {
    log.info("no corpus: tenants, members and spaces come from provisioning");
  }
  await recoverConnections(engine);
  engine.resumeReading().catch((error: unknown) => log.warn("resuming reading after startup failed", { error }));
  const server = await serveApi(engine, Number(values.port), identity);
  // Resume committed work after a restart, including events whose request already returned.
  engine.settleLater();
  const delivering = persistent ? setInterval(() => engine.settleLater(), 1000) : undefined;
  // Reading a spent budget or an outage stopped carries on once the budget renews or the model answers.
  const resuming = setInterval(() => {
    engine.resumeReading().catch((error: unknown) => log.warn("resuming reading failed", { error }));
  }, RESUME_EVERY_MS);
  const stop = () => {
    clearInterval(resuming);
    clearInterval(organize);
    clearInterval(delivering);
    server.close();
    void engine
      .close()
      .then(() => models?.close())
      .then(() => client && closeClient(client))
      .then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (existsSync(".env")) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) process.env[name] ??= value;
  }
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
