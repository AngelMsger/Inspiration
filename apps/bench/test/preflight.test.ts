import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Corpus, Engine } from "@inspiration/engine";
import { workspaceRoot } from "@inspiration/kernel";
import { hasStack, stackTest } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { catalogueCoverage, coverageLines, readableDocuments } from "../src/preflight.ts";
import type { Keys } from "../src/questions.ts";

const keys = (...facts: string[]) =>
  ({ asked_on: "2026-11-02", facts: Object.fromEntries(facts.map((f) => [f, { about: f, values: [] }])) }) as Keys;
const catalogue = (...predicates: string[]) =>
  ({ vocabulary: { predicates: predicates.map((predicate) => ({ predicate })) } }) as unknown as Corpus;

describe("what a paid run checks before it pays", () => {
  test("a keyed fact counts as catalogued by its predicate, whatever its subject and qualifiers", () => {
    const c = catalogueCoverage(catalogue("hotel_cap"), keys("acme/hotel_cap|us", "tips_limit", "hotel_cap"));
    expect(c).toEqual({ facts: 3, uncatalogued: ["tips_limit"] });
    expect(coverageLines(c, false).start).toBe(true);
    expect(coverageLines(c, false).lines.join()).toContain("1 of 3 keyed facts have no catalogue entry");
  });

  test("a run whose catalogue names none of its keyed facts does not start unless told to", () => {
    const none = catalogueCoverage({} as Corpus, keys("hotel_cap", "tips_limit"));
    expect(none.uncatalogued).toEqual(["hotel_cap", "tips_limit"]);
    expect(coverageLines(none, false).start).toBe(false);
    expect(coverageLines(none, true).start).toBe(true);
    expect(coverageLines(catalogueCoverage(catalogue("hotel_cap"), keys("hotel_cap")), false)).toEqual({
      lines: [],
      start: true,
    });
  });

  test("only indexed documents the reader may read count, and deleted ones are left out", async () => {
    const asked: string[] = [];
    const engine = {
      retrieval: {
        documents: async () => [
          { document: "src_a:one.md", chunk_ids: [] },
          { document: "src_a:two.md", chunk_ids: [] },
          { document: "src_a:gone.md", chunk_ids: [], deleted: true },
        ],
      },
      authz: {
        checkMany: async (_who: unknown, _perm: unknown, resources: { id: string }[]) => {
          asked.push(...resources.map((r) => r.id));
          return resources.map((r) => ({ allow: r.id === "src_a:one.md" }));
        },
      },
    } as unknown as Engine;
    const corpus = { reader: { tenant_id: "ten_01PREFLIGHT000000000TENANT" } } as unknown as Corpus;
    expect(await readableDocuments(engine, corpus)).toEqual({ indexed: 2, readable: 1 });
    expect(asked).toEqual(["src_a:one.md", "src_a:two.md"]);
  });
});

/** Runs the bench CLI in a process of its own, as a person would. */
function bench(...args: string[]): Promise<{ code: number; stderr: string }> {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args], (error, _stdout, stderr) => {
      done({ code: error ? Number(error.code) : 0, stderr });
    });
  });
}

/** A corpus of one policy and one question, which the first run on a database may read. */
async function policyCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-preflight-"));
  await mkdir(join(dir, "topic"));
  await writeFile(join(dir, "topic", "policy.md"), "# Travel\n\nHotel stays are reimbursable up to $300 per night.\n");
  await writeFile(join(dir, "topic", ".acl.yaml"), "readers: [tenant]\n");
  await writeFile(
    join(dir, "corpus.yaml"),
    JSON.stringify({
      tenant: { id: "ten_01PREFLIGHT000000000TENANT", name: "Preflight" },
      spaces: [{ id: "spc_01PREFLIGHT0000000000SPACE", name: "Travel" }],
      sources: [
        {
          id: "src_01PREFLIGHT0000000000TOPIC",
          type: "folder",
          space: "spc_01PREFLIGHT0000000000SPACE",
          name: "Topic",
          root: "topic",
          governance_level: "governed",
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "questions.yaml"),
    JSON.stringify({ questions: [{ question: "Up to how much is a hotel night?", answer: ["$300"] }] }),
  );
  return dir;
}

describe.skipIf(!hasStack())("a run that stops before its questions", () => {
  stackTest(
    "still writes its report and cost when resumed on a database whose permissions were in memory",
    { timeout: 120_000 },
    async ({ databaseUrl }) => {
      const dir = await policyCorpus();
      const gateway = join(workspaceRoot(), "config", "gateway.dev.yaml");
      const run = async (json: string) => {
        const { code, stderr } = await bench(
          "ingest",
          dir,
          "--database",
          databaseUrl,
          "--gateway",
          gateway,
          "--json",
          json,
        );
        return { code, stderr, report: JSON.parse(await readFile(json, "utf8")) };
      };

      const fresh = await run(join(dir, "fresh.json"));
      expect(fresh.code).toBe(0);
      expect(fresh.report.questions).toBeDefined();
      expect(fresh.report.cost).toBeDefined();
      expect(fresh.report.stopped).toBeUndefined();

      const resumed = await run(join(dir, "resumed.json"));
      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toContain("stopped before questions: the reader may read none of the 1 indexed documents");
      expect(resumed.report.questions).toBeUndefined();
      expect(resumed.report.stopped).toMatchObject({ before: "questions", indexed: 1, readable: 0 });
      expect(resumed.report.stopped.reason).toContain("replay into a fresh one");
      expect(resumed.report.cost).toBeDefined();
    },
  );
});
