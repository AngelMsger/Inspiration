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
    expect([Object.keys(keys.facts).length, quotes]).toEqual([36, 113]);
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
  test("the engine, plain retrieval and a model reading everything answer the same questions", {
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
      const score = (right: number, stale: number) => ({ right, stale });
      expect(asked.totals).toEqual({
        questions: 150,
        right: 47,
        stale: 3,
        as_recorded: 47,
        cited_right: 91,
        found: 63,
        notes: 57,
        baselines: { passages: 44, long_context: 49 },
        by_kind: {
          changed: { questions: 66, engine: score(13, 3), passages: score(10, 5), long_context: score(13, 6) },
          not_stated: { questions: 15, engine: score(2, 0), passages: score(2, 1), long_context: score(2, 2) },
          unchanged: { questions: 69, engine: score(32, 0), passages: score(32, 0), long_context: score(34, 0) },
        },
        by_language: {
          en: { questions: 50, engine: score(28, 2), passages: score(26, 5), long_context: score(31, 7) },
          ja: { questions: 50, engine: score(6, 0), passages: score(8, 0), long_context: score(8, 1) },
          zh: { questions: 50, engine: score(13, 1), passages: score(10, 1), long_context: score(10, 0) },
        },
      });
      const answerTo = (start: string) =>
        asked.questions.find((q) => q.question.startsWith(start)) as (typeof asked.questions)[number];
      // A copy of the policy from 2021 says 30 days: plain retrieval answers with it. The engine
      // answers with the policy's 90: the copy is an older edition of the copies saved since.
      const deadline = answerTo("Within how many days");
      expect(deadline).toMatchObject({ outcome: "right", baselines: { passages: { outcome: "stale" } } });
      expect(deadline.cited).not.toContain("drive/downloads/expenses.md");
      // The monitor caps left the policy in December 2021; only that copy still states them.
      expect(answerTo("How much can I expense for an external 16:9 monitor")).toMatchObject({
        outcome: "wrong_answer",
        baselines: { passages: { outcome: "stale" } },
      });
    } finally {
      await engine.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
