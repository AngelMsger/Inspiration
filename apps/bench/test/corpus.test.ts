import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Corpus } from "@inspiration/engine";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-corpus-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(dir, ...path.split("/")), text);
}

/** A corpus with one governed folder and one only searched, 200 pages in it. */
async function corpus(haystack: Record<string, unknown> = {}): Promise<void> {
  await put("topic/policy.md", "# Policy\n");
  for (let i = 0; i < 200; i++) await put(`haystack/team-${i % 7}/page-${i}.md`, `# Page ${i}\n`);
  await put("haystack/.hidden/page.md", "# Hidden\n");
  const spec = {
    id: "src_01CORPUSTEST00000HAYSTACK",
    type: "folder",
    space: "spc_01CORPUSTEST000000000SPACE",
    name: "Haystack",
    root: "haystack",
    governance_level: "search_only",
    ...haystack,
  };
  await put(
    "corpus.yaml",
    JSON.stringify({
      tenant: { id: "ten_01CORPUSTEST0000000TENANT", name: "Test" },
      spaces: [{ id: "spc_01CORPUSTEST000000000SPACE", name: "Space" }],
      sources: [
        {
          id: "src_01CORPUSTEST000000000TOPIC",
          type: "folder",
          space: "spc_01CORPUSTEST000000000SPACE",
          name: "Topic",
          root: "topic",
          governance_level: "governed",
        },
        spec,
      ],
    }),
  );
}

function kept(c: Corpus): string[] | undefined {
  return c.sources.find((s) => s.name === "Haystack")?.scope.include;
}

describe("corpus sources that keep some of their files", () => {
  test("a sample keeps about that share, and a smaller share keeps a subset of a larger one", async () => {
    await corpus();
    const small = kept(await Corpus.load(dir, { sample: 0.2 })) ?? [];
    const large = kept(await Corpus.load(dir, { sample: 0.6 })) ?? [];
    expect(small.length).toBeGreaterThan(20);
    expect(small.length).toBeLessThan(60);
    expect(large.length).toBeGreaterThan(small.length);
    expect(small.every((p) => large.includes(p))).toBe(true);
    expect(large.some((p) => p.startsWith(".hidden"))).toBe(false);
    expect(kept(await Corpus.load(dir, { sample: 0.2 }))).toEqual(small);
    // The governed source is never sampled.
    expect((await Corpus.load(dir, { sample: 0.2 })).sources.find((s) => s.name === "Topic")?.scope.include).toBe(
      undefined,
    );
  });

  test("include and exclude are passed on, and a sample applies within them", async () => {
    await corpus({ include: ["team-1/**", "team-2/**"], exclude: ["**/page-8.md"] });
    expect(kept(await Corpus.load(dir))).toEqual(["team-1/**", "team-2/**"]);
    expect((await Corpus.load(dir)).sources.find((s) => s.name === "Haystack")?.scope.exclude).toEqual([
      "**/page-8.md",
    ]);
    const sampled = kept(await Corpus.load(dir, { sample: 0.5 })) ?? [];
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.every((p) => /^team-[12]\//.test(p) && p !== "team-1/page-8.md")).toBe(true);
  });

  test("a sample that keeps nothing leaves the source out, and a share outside 0 to 1 is refused", async () => {
    await corpus();
    expect((await Corpus.load(dir, { sample: 0 })).sources.map((s) => s.name)).toEqual(["Topic"]);
    await expect(Corpus.load(dir, { sample: 1.5 })).rejects.toThrow(/sample/);
  });

  test("an include written empty, with no sample, still means every file and keeps the source", async () => {
    await corpus({ include: [] });
    expect((await Corpus.load(dir)).sources.map((s) => s.name)).toEqual(["Topic", "Haystack"]);
  });
});
