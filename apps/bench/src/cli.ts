#!/usr/bin/env node
/**
 * inspiration-bench ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]
 *                    [--today <YYYY-MM-DD>] [--on-use <n>] [--edit <share>] [--days <n>] [--context <tokens>]
 *                    [--compact <passages>,<statements>]
 *                    [--gateway <file> [--dry-run]] [--questions <n>] [--search-only]
 * inspiration-bench synthesize <dir> --documents <n> [--seed <n>]
 * inspiration-bench replay <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]
 * inspiration-bench ask <corpus> <question> [--stack | --database <url> [--valkey <url>]]
 * inspiration-bench cache export|import <file> [--stack | --valkey <url>] [--gateway <file>]
 *
 * ingest syncs and normalizes a corpus (see examples/corpus) and prints the report. Without
 * --stack or --database everything stays in memory, which suits the demo corpus; scale runs
 * need Postgres. --stack takes the database, Valkey and blob settings from INSPIRATION_*.
 * --today sets the day governance and freshness take as now. --on-use reads n passages of
 * reference documents as their first citation would, and times it (see onuse.ts). --edit
 * edits that share of a synthesized corpus in place (see edit in synthesize.ts) and ingests
 * it again, reporting the second round on its own. --days then runs the daily tick for n
 * days from today and reports the inbox at the end: every owner's cards and notes per week.
 * --context sets how many tokens the long-context rival of the question check reads at most.
 * --compact sets how many passages and statements the engine's compact answer reads
 * (COMPACT_SOURCES unless given), to measure smaller inputs before paying for their answers.
 * --questions asks only n of them, spread over the list (sampleQuestions). --search-only asks
 * search alone, where each answer would be found, and pays for no answers (searchReport).
 *
 * --gateway runs every command on the model gateway that file configures (for real models,
 * config/gateway.deepseek.yaml) instead of the development stand-ins, and reports what the
 * calls cost by task and by answering path. A Valkey response cache in it uses --valkey or
 * the stack's. --dry-run keeps that config's models, prices and routes but answers with the
 * stand-ins (standIn), so the cost reported is an estimate of the run, made before paying
 * for it. A real run with --stack or --database also meters into the database, so the
 * config's day budget counts the day's earlier runs.
 *
 * synthesize writes a synthetic corpus of about n documents, with truth.json listing every
 * fact it states, for scale runs.
 *
 * A corpus with an expected.yaml (examples/control) also gets the control check, case by case
 * (see control.ts), one with a questions.yaml the question check (see questions.ts), and one
 * with a keys.yaml the reading check (see reading.ts).
 *
 * ask ingests the corpus and answers one question as the corpus's reader, with the answer's
 * citations and notes.
 *
 * replay writes the versions history.yaml lists into a working copy of the corpus one at a
 * time, each on its own day, ingests after each and prints what governance led with, checked
 * against timeline.yaml when there is one (see history.ts and examples/gitlab-expenses).
 *
 * cache export writes every model reply in the gateway's Valkey response cache to a JSON lines
 * file; cache import puts them back, for the TTL that --gateway's config gives (30 days
 * without one). A run on real models exports its replies when it ends, and the next run,
 * in a fresh container too, imports them first (see replies.ts and apps/bench/runs).
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Corpus, Engine, type EngineOptions } from "@inspiration/engine";
import { loadSettings, openPool, type Pool } from "@inspiration/kernel";
import { Gateway, loadGatewayConfig, PostgresUsage, standIn, ValkeyCache } from "@inspiration/model-gateway";
import type { Truth } from "./claims.ts";
import { controlLines, controlReport, loadControl } from "./control.ts";
import { costLines, costReport, RunUsage } from "./cost.ts";
import { days, SimulatedClock } from "./freshness.ts";
import { loadHistory, loadTimeline, replay, replayLines } from "./history.ts";
import { inboxLines, inboxReport } from "./inbox.ts";
import { daysSummary, ingest, plantedDuplicates, summary } from "./ingest.ts";
import { onUse, onUseSummary } from "./onuse.ts";
import {
  loadKeys,
  loadQuestions,
  questionLines,
  questionsReport,
  sampleQuestions,
  searchLines,
  searchReport,
} from "./questions.ts";
import { readingLines, readingReport } from "./reading.ts";
import { exportReplies, importReplies } from "./replies.ts";
import { edit, synthesize } from "./synthesize.ts";

const USAGE = [
  "usage: inspiration-bench ingest <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]",
  "                          [--today <YYYY-MM-DD>] [--on-use <n>] [--edit <share>] [--days <n>] [--context <tokens>]",
  "                          [--compact <passages>,<statements>]",
  "                          [--gateway <file> [--dry-run]] [--questions <n>] [--search-only]",
  "       inspiration-bench synthesize <dir> --documents <n> [--seed <n>]",
  "       inspiration-bench replay <corpus> [--stack | --database <url> [--valkey <url>]] [--json <file>]",
  "       inspiration-bench ask <corpus> <question> [--stack | --database <url> [--valkey <url>]]",
  "       inspiration-bench cache export|import <file> [--stack | --valkey <url>] [--gateway <file>]",
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
      "on-use": { type: "string" },
      edit: { type: "string" },
      days: { type: "string" },
      context: { type: "string" },
      compact: { type: "string" },
      gateway: { type: "string" },
      "dry-run": { type: "boolean" },
      questions: { type: "string" },
      "search-only": { type: "boolean" },
    },
  });
  const [command, dir, ...rest] = positionals;
  if (command === "synthesize" && dir && values.documents) {
    const made = await synthesize(dir, { documents: Number(values.documents), seed: Number(values.seed ?? 1) });
    console.log(
      `${made.documents} documents, ${made.statements} fact statements, ${made.duplicates.length} planted duplicates in ${dir}`,
    );
    return 0;
  }
  if (command === "cache" && (dir === "export" || dir === "import") && rest.length === 1) {
    const file = rest[0] as string;
    const url = values.valkey ?? (values.stack ? loadSettings().valkeyUrl : undefined);
    if (!url) {
      console.error("cache export and import need --valkey or --stack");
      return 2;
    }
    const cache = ValkeyCache.fromUrl(url);
    try {
      if (dir === "export") console.log(`${await exportReplies(cache, file)} replies written to ${file}`);
      else {
        const ttl = values.gateway ? loadGatewayConfig(values.gateway).cache.ttl_s : 30 * 24 * 3600;
        console.log(`${await importReplies(cache, file, ttl)} replies read from ${file}`);
      }
    } finally {
      await cache.close();
    }
    return 0;
  }
  const question = rest.join(" ").trim();
  if ((command !== "ingest" && command !== "replay" && command !== "ask") || !dir || (command === "ask" && !question)) {
    console.error(USAGE);
    return 2;
  }
  const compact = values.compact?.match(/^(\d+),(\d+)$/);
  if (values.compact && !compact) {
    console.error("--compact takes the passages and statements a compact answer reads, as 2,8");
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
    ...(values.context && { contextTokens: Number(values.context) }),
    ...(compact && { compactSources: { passages: Number(compact[1]), statements: Number(compact[2]) } }),
  };
  const databaseUrl = values.database ?? settings?.databaseUrl;
  const valkeyUrl = values.valkey ?? settings?.valkeyUrl;
  if (databaseUrl) options.databaseUrl = databaseUrl;
  if (valkeyUrl && databaseUrl) options.valkeyUrl = valkeyUrl;
  if (settings) options.streamPrefix = settings.streamPrefix;
  if (values["dry-run"] && !values.gateway) {
    console.error("--dry-run prices the run a --gateway config would make");
    return 2;
  }
  let cache: ValkeyCache | undefined;
  let gateway: Gateway | undefined;
  let usagePool: Pool | undefined;
  if (values.gateway) {
    const loaded = loadGatewayConfig(values.gateway);
    const config = values["dry-run"] ? standIn(loaded) : loaded;
    if (config.cache.backend === "valkey") {
      if (!valkeyUrl) {
        console.error(`${values.gateway} keeps its response cache in Valkey: give --valkey or --stack`);
        return 2;
      }
      cache = ValkeyCache.fromUrl(valkeyUrl);
    }
    // A real run on a database meters into gateway.usage, so budgets count the day's earlier
    // runs; a dry run's stand-in costs never count against them.
    if (databaseUrl && !values["dry-run"]) usagePool = await openPool(databaseUrl);
    gateway = await Gateway.create(config, {
      ...(cache && { cache }),
      ...(usagePool && { usage: new RunUsage(new PostgresUsage(usagePool)) }),
    });
    options.models = gateway;
  }
  const engine = await Engine.open(options);
  try {
    if (command === "replay") {
      const history = await loadHistory(dir);
      if (!history) {
        console.error(`${dir} has no history.yaml`);
        return 2;
      }
      const timeline = await loadTimeline(dir);
      const report = await replay(engine, dir, history, (at) => clock.set(at.toISOString().slice(0, 10)), {
        ...(timeline && { timeline }),
      });
      console.log(replayLines(report).join("\n"));
      if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    if (command === "ask") {
      const run = await ingest(engine, corpus);
      const answer = await engine.retrieval.answer({ question }, corpus.reader);
      console.log(answer.answer);
      answer.citations.forEach((c, i) => {
        console.log(`  [${i + 1}] ${c.source_title}: ${c.quote.replace(/\s+/g, " ").slice(0, 120)}`);
      });
      for (const n of answer.notes ?? []) console.log(`  ${n.kind}: ${n.text}`);
      if (answer.gaps.length) console.log(`  gaps: ${answer.gaps.join("; ")}`);
      console.log(`  confidence ${answer.confidence}, freshness ${answer.freshness?.state ?? "unknown"}`);
      return run.dead_letters ? 1 : 0;
    }
    const text = await readFile(join(dir, "truth.json"), "utf8").catch(() => undefined);
    const truth = text ? (JSON.parse(text) as Truth & { duplicates: { document: string; of: string }[] }) : undefined;
    const report = await ingest(engine, corpus, truth ? { truth } : {});
    if (truth) report.planted = plantedDuplicates(report.duplicates, truth.duplicates);
    console.log(summary(report));
    const out: Record<string, unknown> = { ...report };
    const control = await loadControl(dir);
    if (control) {
      const checked = await controlReport(engine, corpus, control);
      console.log(`\n${controlLines(checked).join("\n")}`);
      out.control = checked;
    }
    const keys = await loadKeys(dir);
    if (keys) {
      const read = await readingReport(engine, corpus, keys);
      console.log(`\n${readingLines(read).join("\n")}`);
      out.reading = read;
    }
    const listed = await loadQuestions(dir);
    const questions = listed && values.questions ? sampleQuestions(listed, Number(values.questions)) : listed;
    if (questions && values["search-only"]) {
      const searched = await searchReport(engine, corpus, questions);
      console.log(`\n${searchLines(searched).join("\n")}`);
      out.search = searched;
    } else if (questions) {
      const asked = await questionsReport(engine, corpus, questions);
      console.log(`\n${questionLines(asked).join("\n")}`);
      out.questions = asked;
    }
    let deadLetters = report.dead_letters;
    if (values["on-use"]) {
      const used = await onUse(engine, corpus, Number(values["on-use"]));
      console.log(`\n${onUseSummary(used)}`);
      out.on_use = used;
    }
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
      const inbox = await inboxReport(engine, corpus.tenantId);
      console.log(`\n${daysSummary(simulated)}\n${inboxLines(inbox).join("\n")}`);
      out.days = { ...simulated, inbox };
    }
    const cost = gateway && costReport(engine);
    if (cost) {
      console.log(`\n${costLines(cost, values["dry-run"] === true).join("\n")}`);
      out.cost = cost;
    }
    if (values.json) await writeFile(values.json, `${JSON.stringify(out, null, 2)}\n`);
    return deadLetters ? 1 : 0;
  } finally {
    await engine.close();
    await gateway?.close();
    await cache?.close();
    await usagePool?.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
