// Engine migration scoping: Engine.open only migrates engine and library schemas, never
// business-layer schemas (accounts, tenancy, access-grants).

import { discoverMigrations } from "@inspiration/kernel";
import { expect, test } from "vitest";
import { engineMigrations } from "../src/engine.ts";

const BUSINESS_SCHEMAS = ["accounts", "tenancy", "access-grants"];

test("engineMigrations loads only engine and library migration sets", async () => {
  const sets = await engineMigrations();
  const components = sets.map((s) => s.component);
  expect(components).toEqual(
    expect.arrayContaining([
      "bus",
      "kb",
      "gateway",
      "authz",
      "sync",
      "normalization",
      "extraction",
      "freshness",
      "governance",
      "page-compiler",
      "collaboration",
      "retrieval",
    ]),
  );
  for (const business of BUSINESS_SCHEMAS) {
    expect(components).not.toContain(business);
  }
  const all = (await discoverMigrations()).map((s) => s.component);
  for (const business of BUSINESS_SCHEMAS) {
    expect(all).toContain(business);
  }
});
