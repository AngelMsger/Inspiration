// A file URL's pathname keeps percent escapes, so code that hands it to the file system fails
// in a checkout whose path has spaces or letters outside ASCII. Convert with fileURLToPath, or
// pass the URL itself to an API that takes one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PATHNAME = /import\.meta\.url\)\.pathname/;

test("module-relative paths come from fileURLToPath, not a URL's pathname", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && f !== "test/paths.test.ts" && existsSync(join(ROOT, f)));
  expect(files.length).toBeGreaterThan(0);
  const found = files.flatMap((f) =>
    readFileSync(join(ROOT, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (PATHNAME.test(line) ? [`${f}:${i + 1}`] : [])),
  );
  expect(found).toEqual([]);
});
