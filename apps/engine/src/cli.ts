#!/usr/bin/env node
/**
 * inspiration-engine ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]
 * inspiration-engine synthesize <dir> --documents <n> [--seed <n>]
 *
 * ingest syncs and normalizes a corpus (see examples/corpus) and prints the report. Without
 * --stack or --database everything stays in memory, which suits the demo corpus; scale runs
 * need Postgres. --stack takes the database, Valkey and blob settings from INSPIRATION_*.
 *
 * synthesize writes a synthetic corpus of about n documents, with truth.json listing every
 * fact it states, for scale runs.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSettings } from "@inspiration/kernel";
import { Corpus } from "./corpus.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { ingest, plantedDuplicates, summary } from "./ingest.ts";
import { synthesize } from "./synthesize.ts";

const USAGE = [
  "usage: inspiration-engine ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]",
  "       inspiration-engine synthesize <dir> --documents <n> [--seed <n>]",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stack: { type: "boolean" },
      database: { type: "string" },
      valkey: { type: "string" },
      blobs: { type: "string" },
      json: { type: "string" },
      documents: { type: "string" },
      seed: { type: "string" },
    },
  });
  const [command, dir] = positionals;
  if (command === "synthesize" && dir && values.documents) {
    const made = await synthesize(dir, { documents: Number(values.documents), seed: Number(values.seed ?? 1) });
    console.log(
      `${made.documents} documents, ${made.statements} fact statements, ${made.duplicates.length} planted duplicates in ${dir}`,
    );
    return 0;
  }
  if (command !== "ingest" || !dir) {
    console.error(USAGE);
    return 2;
  }
  const corpus = await Corpus.load(dir);
  const settings = values.stack ? loadSettings() : undefined;
  const options: EngineOptions = {
    blobDir: values.blobs ?? settings?.blobDir ?? (await mkdtemp(join(tmpdir(), "inspiration-blobs-"))),
    resolvePrincipal: corpus.resolvePrincipal,
  };
  const databaseUrl = values.database ?? settings?.databaseUrl;
  const valkeyUrl = values.valkey ?? settings?.valkeyUrl;
  if (databaseUrl) options.databaseUrl = databaseUrl;
  if (valkeyUrl && databaseUrl) options.valkeyUrl = valkeyUrl;
  if (settings) options.streamPrefix = settings.streamPrefix;
  const engine = await Engine.open(options);
  try {
    const report = await ingest(engine, corpus);
    const truth = await readFile(join(dir, "truth.json"), "utf8").catch(() => undefined);
    if (truth) report.planted = plantedDuplicates(report.duplicates, JSON.parse(truth).duplicates);
    console.log(summary(report));
    if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
    return report.dead_letters ? 1 : 0;
  } finally {
    await engine.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
