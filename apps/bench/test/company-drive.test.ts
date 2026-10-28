import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Corpus, Engine } from "@inspiration/engine";
import { languageOf } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  ingest,
  type Keys,
  loadKeys,
  loadQuestions,
  type Question,
  questionsReport,
  readingReport,
  SimulatedClock,
} from "../src/index.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const DRIVE = join(EXAMPLES, "company-drive");

/** A file's text as a reader sees it: HTML without its tags, every run of spaces one space. */
async function textOf(path: string): Promise<string> {
  let text = await readFile(join(DRIVE, path), "utf8");
  if (path.endsWith(".html")) {
    text = text
      .replace(
        /<\/?(td|th|li|p|h\d|tr|caption|figcaption|dd|dt|br|div|table|tbody|thead|ul|ol|dl|blockquote|section)\b[^>]*>/g,
        " ",
      )
      .replace(/<[^>]+>/g, "")
      .replace(/&(amp|lt|gt|quot);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e] as string);
  }
  return text.replace(/\s+/g, " ");
}

/** The revision of each file, from files.yaml and, for the engineering docs, examples/kubernetes-docs/sources.yaml. */
async function revisions(): Promise<Map<string, string>> {
  const drive = parse(await readFile(join(DRIVE, "files.yaml"), "utf8")) as {
    files: { path: string; revision: string }[];
  };
  const docs = parse(await readFile(join(EXAMPLES, "kubernetes-docs/sources.yaml"), "utf8")) as {
    files: { file: string; revision: string }[];
  };
  return new Map([
    ...drive.files.map((f): [string, string] => [f.path, f.revision]),
    ...docs.files.map((f): [string, string] => [`../kubernetes-docs/docs/${f.file}`, f.revision]),
  ]);
}

describe("the company drive", () => {
  test("every key quotes its file verbatim, at the revision it names", async () => {
    const keys = (await loadKeys(DRIVE)) as Keys;
    const known = await revisions();
    let quotes = 0;
    for (const [fact, key] of Object.entries(keys.facts)) {
      for (const value of key.values) {
        for (const s of value.stated) {
          expect(s.revision, `${fact}: ${s.file}`).toBe(known.get(s.file));
          expect(await textOf(s.file), `${fact}: ${s.quote}`).toContain(s.quote.replace(/\s+/g, " "));
          quotes++;
        }
      }
    }
    expect([Object.keys(keys.facts).length, quotes]).toEqual([36, 114]);
  });

  test("a third of the questions in each language, about as many on changed facts as on unchanged ones", async () => {
    const questions = (await loadQuestions(DRIVE)) as Question[];
    const count = (of: (q: Question) => string) =>
      Object.fromEntries(
        [...new Set(questions.map(of))].sort().map((k) => [k, questions.filter((q) => of(q) === k).length]),
      );
    expect(count((q) => q.kind)).toEqual({ changed: 66, not_stated: 15, unchanged: 69 });
    expect(count((q) => languageOf(q.question))).toEqual({ en: 50, ja: 50, zh: 50 });
  });

  // In memory only: this measures the pipeline on 311,000 tokens, and kubernetes.test.ts runs
  // the question check on the stack.
  test("the engine, a mature RAG and a model reading everything, raw and governed, answer the same questions", {
    timeout: 300_000,
  }, async () => {
    const work = await mkdtemp(join(tmpdir(), "inspiration-drive-"));
    await cp(DRIVE, join(work, "company-drive"), { recursive: true });
    await cp(join(EXAMPLES, "kubernetes-docs/docs"), join(work, "kubernetes-docs/docs"), { recursive: true });
    const corpus = await Corpus.load(join(work, "company-drive"));
    const clock = new SimulatedClock(new Date("2026-10-27T09:00:00Z"));
    const engine = await Engine.open({
      clock: clock.now,
      blobDir: join(work, ".blobs"),
      resolvePrincipal: corpus.resolvePrincipal,
      vocabulary: () => corpus.vocabulary,
      contextTokens: 1_000_000,
    });
    try {
      const report = await ingest(engine, corpus);
      expect(report.dead_letters).toBe(0);
      // Editions of one document: the policy and its backup; the copies on the drive, which kept
      // the policy's old title, in a chain; and the two revisions of each article.
      expect(report.duplicates.map((d) => `${d.document} ~ ${d.duplicate_of}`).sort()).toEqual([
        "drive/finance/expenses-2022.md ~ drive/downloads/expenses.md",
        "drive/finance/expenses-2022.md ~ drive/finance/expense-policy-2023.md",
        "drive/research/en/shinkansen.html ~ drive/research/en/shinkansen-2024.html",
        "drive/research/ja/shinkansen.html ~ drive/research/ja/shinkansen-2024.html",
        "drive/research/zh/shinkansen.html ~ drive/research/zh/shinkansen-2024.html",
        "handbook/finance/expenses.md ~ handbook/finance/expenses-backup-2024.md",
      ]);
      // The policy holds over its backup and the older copies on the drive, without a person.
      const verdicts = await engine.governance.verdicts(corpus.tenantId, [
        "expense_claim_deadline_days",
        "meal_allowance_per_day",
      ]);
      expect(verdicts.map((v) => v.values.map((x) => `${x.value} ${x.standing}`))).toEqual([
        ["90 day holds", "30 day outdated"],
        ["120 USD/day holds", "100 USD/day outdated"],
      ]);

      // How the stand-in read the drive against the key: README.md gives the numbers.
      const read = await readingReport(engine, corpus, (await loadKeys(corpus.dir)) as Keys);
      expect(read.totals).toEqual({ stated: 77, found: 42, misread: 21, missed: 14, extra: 262 });
      expect(Object.values(read.uncatalogued)).toHaveLength(12);
      expect(read.facts.cluster_max_nodes?.found).toEqual([
        "../kubernetes-docs/docs/setup/best-practices/cluster-large.html: 5000 node",
        "../kubernetes-docs/docs/setup/best-practices/cluster-large.ja.html: 5000 node",
        "../kubernetes-docs/docs/setup/best-practices/cluster-large.zh-cn.html: 5000 node",
      ]);

      const questions = (await loadQuestions(corpus.dir)) as Question[];
      const asked = await questionsReport(engine, corpus, questions);
      // The numbers README.md gives.
      const score = ([right, stale]: [number, number]) => ({ right, stale });
      // Right and stale answers of the engine, the mature RAG, reading everything, and reading it after governance.
      type Pair = [number, number];
      const paths = (engine: Pair, mature: Pair, raw: Pair, governed: Pair) => ({
        engine: score(engine),
        mature: score(mature),
        long_context: score(raw),
        governed_long_context: score(governed),
      });
      const { latency, ...totals } = asked.totals;
      expect(Object.keys(latency).sort()).toEqual(["engine", "governed_long_context", "long_context", "mature"]);
      expect(totals).toEqual({
        questions: 150,
        right: 47,
        stale: 6,
        as_recorded: 47,
        cited_right: 87,
        found: 79,
        notes: 55,
        baselines: { mature: 44, long_context: 49, governed_long_context: 48 },
        by_kind: {
          changed: { questions: 66, ...paths([15, 6], [10, 6], [13, 6], [16, 5]) },
          not_stated: { questions: 15, ...paths([2, 0], [2, 1], [2, 2], [2, 0]) },
          unchanged: { questions: 69, ...paths([30, 0], [32, 0], [34, 0], [30, 0]) },
        },
        by_language: {
          en: { questions: 50, ...paths([28, 4], [25, 6], [31, 7], [29, 3]) },
          ja: { questions: 50, ...paths([6, 1], [8, 1], [8, 1], [7, 1]) },
          zh: { questions: 50, ...paths([13, 1], [11, 0], [10, 0], [12, 1]) },
        },
      });
      const answerTo = (start: string) =>
        asked.questions.find((q) => q.question.startsWith(start)) as (typeof asked.questions)[number];
      // A copy of the policy from 2021 says 30 days: the mature RAG's stand-in answers with it. The
      // engine answers with the policy's 90: the copy is an older edition of the copies saved since.
      const deadline = answerTo("Within how many days");
      expect(deadline).toMatchObject({ outcome: "right", baselines: { mature: { outcome: "stale" } } });
      expect(deadline.cited).not.toContain("drive/downloads/expenses.md");
      // The monitor caps left the policy in December 2021; only that copy still states them.
      expect(answerTo("How much can I expense for an external 16:9 monitor")).toMatchObject({
        outcome: "wrong_answer",
        baselines: { mature: { outcome: "stale" } },
      });
    } finally {
      await engine.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
