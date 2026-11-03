// Code grows by small steps nobody notices, so the size and shape rules of "Keeping the code
// simple" in AGENTS.md are checked here: files stay under a line limit, a package's src/ has at
// most one level of folders, and no file or folder is a grab bag. Function complexity is
// Biome's check (biome.json).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_LINES = 800;
/**
 * Files over MAX_LINES when the limit came in, each with a ceiling. Split them when their
 * component next gains a feature; lower a ceiling as a file shrinks, and never raise one.
 */
const CEILINGS: Record<string, number> = {
  "engine/retrieval/src/retrieval.ts": 1500,
  "apps/bench/src/questions.ts": 1300,
  "engine/page-compiler/src/topics.ts": 1100,
  "engine/governance/test/governance.test.ts": 1000,
};
const GENERATED = new Set(["libs/contracts/src/generated.ts", "libs/contracts/src/events.ts"]);
const GRAB_BAGS = /^(utils?|helpers?|misc|common|shared)(\.|$)/;

/** Hand-written TypeScript (.ts and .tsx) in the packages and the repo-wide tests, tracked or new. */
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => /^(engine|libs|apps|business|test)\//.test(f) && !GENERATED.has(f) && existsSync(join(ROOT, f)));
function lineCount(f: string): number {
  const text = readFileSync(join(ROOT, f), "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

test(`a TypeScript file has at most ${MAX_LINES} lines, or its ceiling`, () => {
  expect(files.length).toBeGreaterThan(0);
  const over = files.flatMap((f) => {
    const n = lineCount(f);
    const limit = CEILINGS[f] ?? MAX_LINES;
    return n > limit ? [`${f}: ${n} lines, limit ${limit}`] : [];
  });
  expect(over).toEqual([]);
});

test("every ceiling belongs to a file still over the limit", () => {
  const stale = Object.keys(CEILINGS).filter((f) => !files.includes(f) || lineCount(f) <= MAX_LINES);
  expect(stale).toEqual([]);
});

test("a package's src/ has at most one level of folders", () => {
  const deep = files.filter((f) => /^(engine|libs|apps|business)\/[^/]+\/src\/[^/]+\/[^/]+\//.test(f));
  expect(deep).toEqual([]);
});

test("no file or folder is named utils, helpers, misc, common or shared", () => {
  const vague = files.filter((f) => f.split("/").some((part) => GRAB_BAGS.test(part)));
  expect(vague).toEqual([]);
});
