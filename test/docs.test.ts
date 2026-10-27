// Docs drift quietly: a Chinese copy misses a section, a link points at a moved file, a
// design doc is replaced and nothing says so. These checks keep every doc listed in the docs
// index with the status it states, every Chinese copy in step with its English doc, and every
// relative link in the docs, the READMEs and AGENTS.md pointing at a file that exists.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** What a design doc's status line may say first. */
const STATUSES = ["adopted", "proposed", "superseded"];

/** Files in the checkout, tracked or new, without the ignored ones. */
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f && existsSync(join(ROOT, f)));

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The lines of a Markdown file outside fenced code blocks. */
function prose(f: string): string[] {
  let fenced = false;
  return read(f)
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced) return true;
      return false;
    });
}

/** The relative link targets of a Markdown file, without their fragments. */
function links(f: string): string[] {
  return prose(f)
    .flatMap((line) => [...line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string))
    .filter((u) => !/^([a-z]+:|#)/.test(u))
    .map((u) => decodeURIComponent(u.split("#")[0] as string))
    .filter((u) => u.length > 0);
}

const englishDocs = files.filter((f) => /^docs\/(?!zh\/).+\.md$/.test(f));
/** Each English doc with its Chinese copy: docs/zh/ for docs, a README.zh.md beside any other README. */
const pairs = [
  ...englishDocs.map((f) => [f, f.replace(/^docs\//, "docs/zh/")] as const),
  ...files.filter((f) => f.endsWith("README.zh.md")).map((f) => [f.replace(/\.zh\.md$/, ".md"), f] as const),
].filter(([en, zh]) => files.includes(en) && files.includes(zh));

describe("docs", () => {
  test("every Chinese copy keeps its English doc's headings", () => {
    const levels = (f: string) => prose(f).flatMap((line) => /^(#{1,6}) /.exec(line)?.[1]?.length ?? []);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.filter(([en, zh]) => levels(en).join() !== levels(zh).join())).toEqual([]);
  });

  test("relative links in the docs, the READMEs and AGENTS.md resolve", () => {
    const sources = files.filter(
      (f) => /^docs\/.+\.md$/.test(f) || /^[^/]+\.md$/.test(f) || /^examples\/([^/]+\/)?README(\.zh)?\.md$/.test(f),
    );
    const broken = sources.flatMap((f) =>
      links(f)
        .filter((u) => !existsSync(join(ROOT, dirname(f), u)))
        .map((u) => `${f}: ${u}`),
    );
    expect(broken).toEqual([]);
  });

  test.each([
    ["docs/README.md", englishDocs],
    ["docs/zh/README.md", files.filter((f) => /^docs\/zh\/.+\.md$/.test(f))],
  ])("%s lists every doc", (index, docs) => {
    const listed = new Set(links(index).map((u) => normalize(join(dirname(index), u))));
    expect(docs.filter((f) => f !== index && !listed.has(f))).toEqual([]);
  });

  test("every design doc states its status, and the docs index repeats it", () => {
    const rows = read("docs/README.md").split("\n");
    const design = englishDocs.filter((f) => /^docs\/design\/[^/]+\.md$/.test(f));
    expect(design.length).toBeGreaterThan(0);
    const wrong = design.flatMap((f) => {
      const stated = /^Status: (\w+)/m.exec(prose(f).slice(0, 5).join("\n"))?.[1]?.toLowerCase();
      if (!stated || !STATUSES.includes(stated)) return [`${f}: no status line starting with ${STATUSES.join(", ")}`];
      const row = rows.find((r) => r.includes(`](${f.slice("docs/".length)})`));
      const indexed = row?.split("|")[2]?.trim().split(/[ ,]/)[0]?.toLowerCase();
      return indexed === stated ? [] : [`${f}: the index says ${indexed ?? "nothing"}, the doc says ${stated}`];
    });
    expect(wrong).toEqual([]);
  });
});
