// Every file in examples/ is a valid instance of the type its name starts with.
//
// File names are "<TypeName>.<case>.json". The examples double as documentation for
// component builders, so keep them realistic.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BUNDLE, contractErrors, schemaErrors, schemaOf } from "../src/index.ts";

const EXAMPLES = new URL("../examples/", import.meta.url);
const files = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".json"))
  .sort();

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, EXAMPLES), "utf8"));
}

describe.each(files)("%s", (file) => {
  const typeName = file.split(".")[0] as string;

  test("is valid against the bundled contracts", () => {
    expect(contractErrors(typeName, load(file))).toEqual([]);
  });

  test("is valid against the standalone schema of its type", () => {
    expect(schemaErrors(schemaOf(typeName), load(file))).toEqual([]);
  });
});

test("the page example uses every block type", () => {
  const page = load("PageSpec.travel-policy.json") as { blocks: { type: string }[] };
  const used = new Set(page.blocks.map((b) => b.type));
  const declared = Object.keys((BUNDLE.$defs.Block as { discriminator: { mapping: object } }).discriminator.mapping);
  expect(declared.filter((t) => !used.has(t))).toEqual([]);
  expect([...used].sort()).toEqual(declared.sort());
});

test("claim evidence carries an exact quote from a span", () => {
  // The knowledge store rejects a claim whose evidence does not point into a span.
  expect(BUNDLE.$defs.ClaimEvidence?.required).toEqual(
    expect.arrayContaining(["span_id", "quote", "source_version_id"]),
  );
});

test.each(["Block", "DataRef", "ViewHostMessage", "ViewGuestMessage"])("%s members have unique tags", (union) => {
  const def = BUNDLE.$defs[union] as { oneOf: unknown[]; discriminator: { mapping: object } };
  expect(Object.keys(def.discriminator.mapping)).toHaveLength(def.oneOf.length);
});

test("an invalid instance is reported with its path", () => {
  const claim = load("Claim.hotel-cap.json");
  delete claim.statement;
  claim.confidence = 2;
  const errors = contractErrors("Claim", claim);
  expect(errors).toContain("(root): must have required property 'statement'");
  expect(errors.some((e) => e.startsWith("/confidence: "))).toBe(true);
});
