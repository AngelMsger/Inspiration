#!/usr/bin/env node
/**
 * inspiration-engine ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]
 *                    [--today <YYYY-MM-DD>] [--edit <share>] [--days <n>]
 * inspiration-engine synthesize <dir> --documents <n> [--seed <n>]
 *
 * ingest syncs and normalizes a corpus (see examples/corpus) and prints the report. Without
 * --stack or --database everything stays in memory, which suits the demo corpus; scale runs
 * need Postgres. --stack takes the database, Valkey and blob settings from INSPIRATION_*.
 * --today sets the day governance and freshness take as now. --edit edits that share of a
 * synthesized corpus in place (see edit in synthesize.ts) and ingests it again, reporting
 * the second round on its own. --days then runs the daily tick for n days from today.
 *
 * synthesize writes a synthetic corpus of about n documents, with truth.json listing every
 * fact it states, for scale runs.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSettings } from "@inspiration/kernel";
import type { Truth } from "./claims.ts";
import { Corpus } from "./corpus.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { days, SimulatedClock } from "./freshness.ts";
import { daysSummary, ingest, plantedDuplicates, summary } from "./ingest.ts";
import { edit, synthesize } from "./synthesize.ts";

const USAGE = [
  "usage: inspiration-engine ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]",
  "                          [--today <YYYY-MM-DD>] [--edit <share>] [--days <n>]",
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
      today: { type: "string" },
      edit: { type: "string" },
      days: { type: "string" },
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
  const clock = new SimulatedClock(values.today ? new Date(`${values.today}T09:00:00Z`) : new Date());
  const options: EngineOptions = {
    blobDir: values.blobs ?? settings?.blobDir ?? (await mkdtemp(join(tmpdir(), "inspiration-blobs-"))),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    clock: clock.now,
  };
  const databaseUrl = values.database ?? settings?.databaseUrl;
  const valkeyUrl = values.valkey ?? settings?.valkeyUrl;
  if (databaseUrl) options.databaseUrl = databaseUrl;
  if (valkeyUrl && databaseUrl) options.valkeyUrl = valkeyUrl;
  if (settings) options.streamPrefix = settings.streamPrefix;
  const engine = await Engine.open(options);
  try {
    const text = await readFile(join(dir, "truth.json"), "utf8").catch(() => undefined);
    const truth = text ? (JSON.parse(text) as Truth & { duplicates: { document: string; of: string }[] }) : undefined;
    const report = await ingest(engine, corpus, truth ? { truth } : {});
    if (truth) report.planted = plantedDuplicates(report.duplicates, truth.duplicates);
    console.log(summary(report));
    const out: Record<string, unknown> = { ...report };
    let deadLetters = report.dead_letters;
    if (values.edit) {
      const edits = await edit(dir, { share: Number(values.edit), day: clock.now().toISOString().slice(0, 10) });
      const round = await ingest(engine, corpus);
      console.log(
        `\nedit round: ${edits.documents} documents edited (${Object.entries(edits.by_kind)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")})`,
      );
      console.log(summary(round));
      out.edit_round = { edits, report: round };
      deadLetters += round.dead_letters;
    }
    if (values.days) {
      const simulated = await days(engine, corpus.tenantId, clock, Number(values.days));
      console.log(`\n${daysSummary(simulated)}`);
      out.days = simulated;
    }
    if (values.json) await writeFile(values.json, `${JSON.stringify(out, null, 2)}\n`);
    return deadLetters ? 1 : 0;
  } finally {
    await engine.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
