import { cp, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Corpus, Engine } from "@inspiration/engine";
import { languageOf } from "@inspiration/kernel";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import {
  type Control,
  controlReport,
  ingest,
  loadControl,
  loadQuestions,
  type Question,
  questionsReport,
  SimulatedClock,
  searchReport,
} from "../src/index.ts";

const KUBERNETES = fileURLToPath(new URL("../../../examples/kubernetes-docs/", import.meta.url));

/**
 * Every page and its translations come out as expected.yaml answers them, and every question
 * of questions.yaml as it answers it, or as their engine entries record. Then, were the
 * English page to raise its node limit, the translations would fall behind: the original's
 * new value holds without a person, freshness asks for both translations to be brought up
 * to date, and a question in Chinese gets the new value, with a note that its page is behind,
 * where the mature RAG over the same chunks still gives the old one.
 */
async function check(stack?: { databaseUrl: string; streamPrefix: string }): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "inspiration-kubernetes-"));
  await cp(KUBERNETES, work, { recursive: true });
  const corpus = await Corpus.load(work);
  const control = (await loadControl(work)) as Control;
  const clock = new SimulatedClock(new Date("2026-10-27T09:00:00Z"));
  const engine = await Engine.open({
    clock: clock.now,
    blobDir: join(work, ".blobs"),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  try {
    expect((await ingest(engine, corpus)).dead_letters).toBe(0);
    const report = await controlReport(engine, corpus, control);
    for (const c of report.cases) expect(c.observed, c.case).toEqual(c.recorded);
    expect(report.unexpected).toEqual({});
    // The numbers README.md gives.
    expect(report.totals).toEqual({
      cases: 4,
      as_expected: 1,
      as_recorded: 4,
      statements: { expected: 33, in_slot: 29, misplaced: 18 },
      values: { expected: 11, sources_right: 9 },
      slots: { expected: 11, proposed_right: 10, cases_right: 7 },
    });
    const questions = (await loadQuestions(work)) as Question[];
    const asked = await questionsReport(engine, corpus, questions);
    for (const q of asked.questions) expect(q.outcome, q.question).toBe(q.expected);
    const score = (right: number) => ({ right, stale: 0 });
    const { latency, ...totals } = asked.totals;
    expect(Object.keys(latency).sort()).toEqual([
      "compact",
      "engine",
      "governed_long_context",
      "long_context",
      "mature",
      "search",
    ]);
    // Right answers of the engine, its compact answer, the mature RAG, reading everything, and reading it after
    // governance.
    const paths = (engine: number, compact: number, mature: number, raw: number, governed: number) => ({
      engine: score(engine),
      compact: score(compact),
      mature: score(mature),
      long_context: score(raw),
      governed_long_context: score(governed),
    });
    expect(totals).toEqual({
      questions: 12,
      right: 9,
      stale: 0,
      as_recorded: 12,
      cited_right: 12,
      found: 11,
      notes: 3,
      baselines: { compact: 10, mature: 8, long_context: 8, governed_long_context: 8 },
      retention: { kept: 11, demoted: 0, dropped: 0, absent: 0, not_audited: 1, beyond_raw: [] },
      by_kind: {
        unchanged: { questions: 11, ...paths(8, 9, 7, 7, 7) },
        not_stated: { questions: 1, ...paths(1, 1, 1, 1, 1) },
      },
      by_language: {
        en: { questions: 8, ...paths(7, 8, 6, 7, 7) },
        ja: { questions: 2, ...paths(0, 0, 0, 0, 0) },
        zh: { questions: 2, ...paths(2, 2, 2, 1, 1) },
      },
    });
    // Search alone, as --search-only runs it, with no answers.
    const searched = await searchReport(engine, corpus, questions);
    expect(searched.totals).toMatchObject({ questions: 11, found: 11, found_whole: 11, found_by_mature: 11 });
    expect(searched.totals.within).toEqual({ 8: 10, 16: 11, 30: 11, 60: 11, 100: 11 });
    expect(searched.totals.within_documents).toEqual({ 1: 10, 3: 11, 5: 11, 10: 11, 20: 11 });
    // The evidence audit reads inputs, not answers, so search alone finds what the question check does.
    expect(searched.totals.retention).toEqual(asked.totals.retention);
    expect(searched.questions.map((q) => q.retention)).toEqual(asked.questions.map((q) => q.retention));

    const page = join(work, "docs/setup/best-practices/cluster-large.html");
    await writeFile(page, (await readFile(page, "utf8")).replaceAll("5,000 nodes", "6,000 nodes"));
    clock.set("2026-11-02");
    await utimes(page, clock.now(), clock.now());
    expect((await ingest(engine, corpus)).dead_letters).toBe(0);
    const { decision } = await engine.governance.slot(corpus.tenantId, "cluster_max_nodes");
    expect(decision?.proposed.value).toBe("6000 node");
    expect(decision?.cases.find((c) => c.value === "5000 node")).toMatchObject({
      classification: "supersession",
      status: "auto_resolved",
    });
    const behind = (await engine.freshness.documents(corpus.tenantId)).filter((d) => d.behind);
    expect(behind.map((d) => corpus.pathOf(...(d.document.split(":") as [string, string]))).sort()).toEqual([
      "docs/setup/best-practices/cluster-large.ja.html",
      "docs/setup/best-practices/cluster-large.zh-cn.html",
    ]);
    const limit = questions.find(
      (q) => languageOf(q.question) === "zh" && q.cites?.includes("docs/setup/best-practices/cluster-large"),
    ) as Question;
    const answer = await engine.retrieval.answer({ question: limit.question }, corpus.reader);
    expect(answer.answer).toContain("6,000");
    expect(answer.answer).not.toContain("5,000");
    expect(answer.notes?.find((n) => n.kind === "outdated")?.text).toContain("5000 node");
    // The mature RAG over the same chunks still answers with the translation's old value: the
    // stand-in answer does not weigh the documents' dates, as a model told to would.
    const mature = await engine.baselines.mature.answer({ question: limit.question }, corpus.reader);
    expect(mature.answer).toContain("5,000");
    expect(mature.answer).not.toContain("6,000");
  } finally {
    await engine.close();
    await rm(work, { recursive: true, force: true });
  }
}

describe("the Kubernetes pages in three languages", () => {
  test("in memory", async () => {
    await check();
  });

  describe.skipIf(!hasStack())("on the stack", () => {
    // Two ingests and 24 searches over Postgres take longer than the default limit.
    stackTest(
      "Postgres with the outbox relayed to Valkey Streams",
      { timeout: 60_000 },
      async ({ databaseUrl, streamPrefix, valkey }) => {
        expect(valkey).toBeDefined(); // removes this run's stream keys afterwards
        await check({ databaseUrl, streamPrefix });
      },
    );
  });
});
