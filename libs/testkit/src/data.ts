/**
 * Test data kept out of test code. Text in a language other than English (Chinese and
 * Japanese documents, headings, queries) lives in YAML files in the package's test/data/, so
 * that code and comments stay in English while tests still read the languages the product
 * serves.
 *
 *     const zh = testData<{ documents: Record<string, string> }>(import.meta.url, "zh.yaml");
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** The YAML file data/<name> next to the test module at base (its import.meta.url). */
export function testData<T>(base: string | URL, name: string): T {
  return parse(readFileSync(new URL(`data/${name}`, base), "utf8")) as T;
}
