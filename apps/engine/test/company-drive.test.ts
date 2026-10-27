import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { languageOf } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  Corpus,
  Engine,
  ingest,
  type Keys,
  loadKeys,
  loadQuestions,
  type Question,
  questionsReport,
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
      expect((await ingest(engine, corpus)).dead_letters).toBe(0);
      // The policy holds over its backup and the older copies on the drive, without a person.
      const verdicts = await engine.governance.verdicts(corpus.tenantId, [
        "expense_claim_deadline_days",
        "meal_allowance_per_day",
      ]);
      expect(verdicts.map((v) => v.values.map((x) => `${x.value} ${x.standing}`))).toEqual([
        ["90 day holds", "30 day outdated"],
        ["120 USD/day holds", "100 USD/day outdated"],
      ]);

      const questions = (await loadQuestions(corpus.dir)) as Question[];
      const asked = await questionsReport(engine, corpus, questions);
      // The numbers README.md gives.
      const score = (right: number, stale: number) => ({ right, stale });
      expect(asked.totals).toEqual({
        questions: 150,
        right: 48,
        stale: 5,
        as_recorded: 48,
        cited_right: 89,
        found: 63,
        notes: 67,
        baselines: { passages: 44, long_context: 49 },
        by_kind: {
          changed: { questions: 66, engine: score(14, 4), passages: score(10, 5), long_context: score(13, 6) },
          not_stated: { questions: 15, engine: score(2, 1), passages: score(2, 1), long_context: score(2, 2) },
          unchanged: { questions: 69, engine: score(32, 0), passages: score(32, 0), long_context: score(34, 0) },
        },
        by_language: {
          en: { questions: 50, engine: score(31, 4), passages: score(26, 5), long_context: score(31, 7) },
          ja: { questions: 50, engine: score(6, 0), passages: score(8, 0), long_context: score(8, 1) },
          zh: { questions: 50, engine: score(11, 1), passages: score(10, 1), long_context: score(10, 0) },
        },
      });
      // A copy of the policy from 2021 says 30 days: plain retrieval answers with it, the engine
      // with the policy's 90 and a note that an older document says otherwise.
      const deadline = asked.questions.find((q) =>
        q.question.startsWith("Within how many days"),
      ) as (typeof asked.questions)[number];
      expect(deadline).toMatchObject({ outcome: "right", baselines: { passages: { outcome: "stale" } } });
      expect(deadline.notes).toEqual([
        "outdated: Expenses still state 30 day; that value was replaced, and 90 day holds.",
      ]);
    } finally {
      await engine.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
