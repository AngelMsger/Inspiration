// Every language pack has the same words with the same blanks, and every word the page asks
// for is in them, including the ones it names after a contract's values.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const LANGUAGES = new URL("../languages/", import.meta.url);
const SRC = new URL("../src/", import.meta.url);
const packs = Object.fromEntries(
  readdirSync(LANGUAGES)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => [
      f.slice(0, -".yaml".length),
      parse(readFileSync(new URL(f, LANGUAGES), "utf8")) as Record<string, string>,
    ]),
);
const en = packs.en as Record<string, string>;
const blanks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const schema = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@inspiration/contracts/schema.json"), "utf8"),
) as { $defs: Record<string, { enum?: string[] }> };
const valuesOf = (type: string) => schema.$defs[type]?.enum ?? [];

describe("language packs", () => {
  test("cover English, Chinese and Japanese", () => {
    expect(Object.keys(packs).sort()).toEqual(["en", "ja", "zh"]);
  });

  test.each(Object.entries(packs))("%s has every word, with the same blanks", (_tag, pack) => {
    expect(Object.keys(pack).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) expect(blanks(pack[key] ?? ""), key).toEqual(blanks(text));
  });

  test("hold every word the page asks for", () => {
    const asked = readdirSync(SRC)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) =>
        [...readFileSync(new URL(f, SRC), "utf8").matchAll(/say\("([a-z_.]+)"/g)].map((m) => m[1] as string),
      );
    expect(asked.length).toBeGreaterThan(20);
    expect(asked.filter((k) => !(k in en))).toEqual([]);
  });

  test("name every value of the contracts the page shows", () => {
    const named = [
      ...valuesOf("GovernanceLevel").map((v) => `level.${v}`),
      ...valuesOf("SlotStanding").map((v) => `standing.${v}`),
      ...valuesOf("HitKind").map((v) => `hit.${v}`),
      ...valuesOf("AnswerNoteKind").map((v) => `note.${v}`),
      ...valuesOf("TodoKind").map((v) => `todo.${v}`),
      ...valuesOf("DecisionVia").map((v) => `decided.via.${v}`),
      ...valuesOf("BudgetPeriod").map((v) => `usage.period.${v}`),
    ];
    expect(named.length).toBeGreaterThan(15);
    expect(named.filter((k) => !(k in en))).toEqual([]);
  });
});
