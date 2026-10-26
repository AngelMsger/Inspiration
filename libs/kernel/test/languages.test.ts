import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { loadLanguages } from "../src/index.ts";

test("packs load from a file URL whose path has spaces and accents", async () => {
  // A file URL's pathname keeps %20 and %C3%A9, which the file system does not know.
  const root = await mkdtemp(join(tmpdir(), "inspiration space checkout café-"));
  try {
    const dir = join(root, "languages");
    await mkdir(dir);
    await writeFile(join(dir, "fr.yaml"), "words: [bonjour]\n");
    await writeFile(join(dir, "en.yaml"), "words: [hello]\n");
    const packs = loadLanguages(pathToFileURL(`${dir}/`));
    expect(packs.map((p) => [p.tag, p.list("words")])).toEqual([
      ["en", ["hello"]],
      ["fr", ["bonjour"]],
    ]);
    expect(loadLanguages(dir).map((p) => p.tag)).toEqual(["en", "fr"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
