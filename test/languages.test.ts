// Code, comments and configuration are in English; text in the other languages the product
// serves lives in data. Han and kana are allowed only in language packs (languages/*.yaml),
// test data (test/data/), sample data (examples/) and the Chinese copies of the docs
// (docs/zh/, *.zh.md). Docs are written in English and every one has a Chinese copy.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The languages the product serves; every component's language packs cover them. */
const LANGUAGES = ["en", "ja", "zh"];
/** Han, kana, and the punctuation and full-width forms that come with them. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
/** Where text in other languages belongs. */
const DATA = [
  /(^|\/)languages\/[^/]+\.yaml$/,
  /(^|\/)test\/data\//,
  /^examples\//,
  /^libs\/contracts\/examples\//,
  /^docs\/zh\//,
  /\.zh\.md$/,
];

/** Files in the checkout, tracked or new, without the ignored ones. */
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f && existsSync(join(ROOT, f)));

describe("languages", () => {
  test("code, comments and configuration hold no Chinese or Japanese", () => {
    const found = files
      // Markdown is prose: an English doc may quote a term in its own language.
      .filter((f) => !f.endsWith(".md") && !DATA.some((p) => p.test(f)))
      .flatMap((f) => {
        const bytes = readFileSync(join(ROOT, f));
        if (bytes.includes(0)) return [];
        return bytes
          .toString("utf8")
          .split("\n")
          .flatMap((line, i) => (CJK.test(line) ? [`${f}:${i + 1}`] : []));
      });
    expect(found).toEqual([]);
  });

  test("every doc has a Chinese copy in docs/zh/", () => {
    const docs = files.filter((f) => /^docs\/(?!zh\/).+\.md$/.test(f));
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.filter((f) => !files.includes(f.replace(/^docs\//, "docs/zh/")))).toEqual([]);
  });

  test("every component's language packs cover the languages the product serves", () => {
    const withPacks = ["libs", "engine", "business"]
      .flatMap((dir) =>
        existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}`) : [],
      )
      .filter((pkg) => existsSync(join(ROOT, pkg, "languages")));
    expect(withPacks.length).toBeGreaterThan(0);
    for (const pkg of withPacks) {
      const tags = readdirSync(join(ROOT, pkg, "languages"))
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.slice(0, -".yaml".length));
      expect(tags.sort(), pkg).toEqual(LANGUAGES);
    }
  });
});
