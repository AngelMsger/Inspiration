import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroundedAnswer } from "@inspiration/contracts";
import { Corpus } from "@inspiration/engine";
import { languageOf } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { type Keys, keepsMeaning, loadKeys, loadQuestions, outcomeOf, PATTERNS, type Question } from "../src/index.ts";
import { catalogueCoverage } from "../src/preflight.ts";

const DECISIVE = fileURLToPath(new URL("../../../examples/decisive-test/", import.meta.url));
/** How far from a quote, in characters, a word naming its fact may be: about one extraction window. */
const NEAR = 1500;

/** A file's text as a reader sees it: HTML without its tags, every run of spaces one space. */
async function textOf(path: string): Promise<string> {
  let text = await readFile(join(DECISIVE, path), "utf8");
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

interface FileEntry {
  path: string;
  kind?: string;
  revision?: string;
  note?: string;
  of?: string;
}

const filesYaml = async () =>
  (parse(await readFile(join(DECISIVE, "files.yaml"), "utf8")) as { files: FileEntry[] }).files;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(join(DECISIVE, dir), { recursive: true, withFileTypes: true });
  // Not the .acl.yaml sidecars, which say who may read a folder.
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => relative(DECISIVE, join(e.parentPath, e.name)));
}

describe("the decisive test's cases", () => {
  test("every key quotes its file verbatim, at the revision files.yaml gives", async () => {
    const keys = (await loadKeys(DECISIVE)) as Keys;
    const revision = new Map((await filesYaml()).map((f) => [f.path, f.revision ?? "constructed"]));
    let quotes = 0;
    for (const [fact, key] of Object.entries(keys.facts)) {
      for (const group of [key.values, key.misleading ?? [], key.conflicting ?? []]) {
        for (const value of group) {
          for (const s of value.stated) {
            expect(s.revision, `${fact}: ${s.file}`).toBe(revision.get(s.file));
            expect(await textOf(s.file), `${fact}: ${s.quote}`).toContain(s.quote.replace(/\s+/g, " "));
            quotes++;
          }
        }
      }
    }
    expect([Object.keys(keys.facts).length, quotes]).toEqual([92, 217]);
  });

  test("every value keeps the key's meaning, as the evidence audit reads it, in a file that states it", async () => {
    // Otherwise the audit would count the value as changed where governance gives the model the
    // document untouched: the key, not governance, would be at fault.
    const keys = (await loadKeys(DECISIVE)) as Keys;
    const unread: string[] = [];
    for (const [fact, key] of Object.entries(keys.facts)) {
      for (const v of [...key.values, ...(key.conflicting ?? [])]) {
        if (v.value === null || !v.texts) continue;
        const quotes = v.stated.map((s) => s.quote);
        const condition = "condition" in v ? v.condition : undefined;
        const read = await Promise.all(
          v.stated.map(async (s) => keepsMeaning(await textOf(s.file), v.texts as string[], quotes, condition)),
        );
        if (!read.some(Boolean)) unread.push(`${fact}: ${v.value}`);
      }
    }
    expect(unread).toEqual([]);
  });

  test("the catalogue names every keyed fact, by a word found near each place the key cites", async () => {
    // Extraction offers a window only the entries whose words it names: an entry no window
    // names leaves its fact without a slot, as a missing entry does.
    const keys = (await loadKeys(DECISIVE)) as Keys;
    const entries = (
      parse(await readFile(join(DECISIVE, "vocabulary.yaml"), "utf8")) as {
        predicates: { predicate: string; aliases: string[] }[];
      }
    ).predicates;
    const aliases = new Map(entries.map((e) => [e.predicate, e.aliases.map((a) => a.toLowerCase())]));
    expect(catalogueCoverage({ vocabulary: { predicates: entries } } as never, keys).uncatalogued).toEqual([]);
    const unnamed: string[] = [];
    for (const [fact, key] of Object.entries(keys.facts)) {
      for (const group of [key.values, key.misleading ?? [], key.conflicting ?? []]) {
        for (const s of group.flatMap((value) => value.stated)) {
          // A quote may stand in several places; extraction reads each, so one named place is enough.
          const text = (await textOf(s.file)).toLowerCase();
          const quote = s.quote.replace(/\s+/g, " ").toLowerCase();
          let named = false;
          for (let at = text.indexOf(quote); at >= 0 && !named; at = text.indexOf(quote, at + 1)) {
            const near = text.slice(Math.max(0, at - NEAR), at + NEAR);
            named = aliases.get(fact)?.some((a) => near.includes(a)) ?? false;
          }
          if (!named) unnamed.push(`${fact}: ${s.file}`);
        }
      }
    }
    expect(unnamed).toEqual([]);
  });

  test("files.yaml lists every file of the topics, and says what each constructed one changes", async () => {
    const files = await filesYaml();
    const listed = new Set(files.map((f) => f.path));
    const onDisk = [
      ...(await filesUnder("gitlab")),
      ...(await filesUnder("kubernetes/docs")),
      ...(await filesUnder("kubernetes/legacy")),
      ...(await filesUnder("kubernetes/platform")),
      ...(await filesUnder("kubernetes/drive")),
    ].sort();
    expect(onDisk).toEqual([...listed].sort());
    for (const f of files) {
      if (f.kind === "constructed" || f.kind === "stale_copy") expect(f.note, f.path).toBeTruthy();
      if (f.of) expect(listed, f.path).toContain(f.of);
    }
    const kinds: Record<string, number> = {};
    for (const f of files) kinds[f.kind ?? "current"] = (kinds[f.kind ?? "current"] ?? 0) + 1;
    expect(kinds).toEqual({ constructed: 15, current: 164, stale_copy: 4 });
    // The manifest and files.yaml load as the engine reads them; the haystack is not needed for that.
    const corpus = await Corpus.load(DECISIVE);
    expect(corpus.files).toHaveLength(183);
  });

  test("each fact is asked once in each language, in every pattern of each topic", async () => {
    const questions = (await loadQuestions(DECISIVE)) as Question[];
    const count = (of: (q: Question) => string) =>
      Object.fromEntries(
        [...new Set(questions.map(of))].sort().map((k) => [k, questions.filter((q) => of(q) === k).length]),
      );
    expect(count((q) => languageOf(q.question))).toEqual({ en: 92, ja: 92, zh: 92 });
    expect(count((q) => `${q.topic} ${q.pattern}`)).toEqual({
      "gitlab changed_elsewhere": 18,
      "gitlab control": 42,
      "gitlab distorted": 18,
      "gitlab governed_disagree": 18,
      "gitlab lagging_translation": 9,
      "gitlab newer_not_authoritative": 21,
      "gitlab renamed_or_moved": 27,
      "gitlab restated_lagging": 24,
      "kubernetes changed_elsewhere": 9,
      "kubernetes control": 30,
      "kubernetes distorted": 6,
      "kubernetes governed_disagree": 6,
      "kubernetes lagging_translation": 24,
      "kubernetes newer_not_authoritative": 6,
      "kubernetes renamed_or_moved": 6,
      "kubernetes restated_lagging": 12,
    });
    expect(new Set(questions.map((q) => q.pattern))).toEqual(new Set(PATTERNS));
    // A long context reads only the question's topic; every topic has its spaces.
    for (const q of questions) expect(q.spaces?.length, q.question).toBe(4);
    // A conflict asks for both values; a draft's value counts as stale.
    const lb = questions.find((q) => q.fact === "loadbalancer_services_per_namespace") as Question;
    expect(lb).toMatchObject({ answer: ["5"], also: [["3"]], kind: "unchanged" });
    expect(lb.cites).toEqual(["kubernetes/platform/cluster-standards.md", "kubernetes/platform/networking-runbook.md"]);
    const iops = questions.find((q) => q.fact === "gold_class_iops") as Question;
    expect(iops.stale).toHaveLength(3);
    expect(iops.stale).toContain("16000");
  });
});

describe("misleading and conflicting values", () => {
  const answer = (text: string): GroundedAnswer =>
    ({ answer_id: "req_1", answer: text, citations: [{}], confidence: 0.9, gaps: [], token_estimate: 1 }) as never;

  test("a draft's value is stale, and a conflict is right only with every governed value named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-keys-"));
    try {
      const stated = (file: string) => [{ file, revision: "r", quote: "q" }];
      await writeFile(
        join(dir, "keys.yaml"),
        JSON.stringify({
          asked_on: "2026-11-02",
          topics: { t: ["spc_1"] },
          facts: {
            cap: {
              about: "A cap",
              topic: "t",
              pattern: "newer_not_authoritative",
              case: "constructed",
              values: [{ from: "2026-01-01", value: "300", texts: ["300"], stated: stated("policy.md") }],
              misleading: [{ value: "350", texts: ["350"], why: "a draft", stated: stated("draft.md") }],
            },
            lead: {
              about: "A lead time",
              topic: "t",
              pattern: "governed_disagree",
              case: "constructed",
              values: [{ from: "2026-01-01", value: "7 days", texts: ["7"], stated: stated("policy.md") }],
              conflicting: [{ value: "14 days", texts: ["14"], stated: stated("travel.md") }],
            },
          },
        }),
      );
      await writeFile(
        join(dir, "questions.yaml"),
        JSON.stringify({
          questions: [
            { fact: "cap", ask: ["Cap?"] },
            { fact: "lead", ask: ["Lead time?"] },
          ],
        }),
      );
      const [cap, lead] = (await loadQuestions(dir)) as [Question, Question];
      expect(cap).toMatchObject({
        answer: ["300"],
        stale: ["350"],
        spaces: ["spc_1"],
        pattern: "newer_not_authoritative",
      });
      expect(lead).toMatchObject({ answer: ["7"], also: [["14"]], cites: ["policy.md", "travel.md"] });
      expect(outcomeOf(cap, answer("$350 a night."), ["draft.md"])).toBe("stale");
      expect(outcomeOf(cap, answer("$300, though a draft proposes $350."), ["policy.md"])).toBe("right");
      expect(outcomeOf(lead, answer("7 days."), ["policy.md"])).toBe("one_sided");
      expect(outcomeOf(lead, answer("14 days."), ["travel.md"])).toBe("one_sided");
      expect(outcomeOf(lead, answer("The policy says 7 days, the travel page 14."), ["travel.md"])).toBe("right");
      // A citation marker is not a value: "[14]" names no 14-day lead time.
      expect(outcomeOf(lead, answer("7 days.[14]"), ["policy.md"])).toBe("one_sided");
      expect(outcomeOf(cap, answer("$350 a night.[300]"), ["draft.md"])).toBe("stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a topic without spaces is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-keys-"));
    try {
      await writeFile(
        join(dir, "keys.yaml"),
        JSON.stringify({
          asked_on: "2026-11-02",
          facts: { cap: { about: "A cap", topic: "t", values: [{ from: "2026-01-01", value: null, stated: [] }] } },
        }),
      );
      await expect(loadKeys(dir)).rejects.toThrow("no spaces for topic t");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
