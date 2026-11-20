// Engine migration scoping: Engine.open only migrates engine and library schemas, never
// business-layer schemas (accounts, tenancy, access-grants).

import { discoverMigrations } from "@inspiration/kernel";
import { expect, test } from "vitest";
import { engineMigrations } from "../src/engine.ts";

const BUSINESS_SCHEMAS = ["accounts", "tenancy", "access-grants"];

test("engineMigrations loads every registered migration set except the business layer's", async () => {
  // Compared with discovery, so a new engine or library schema cannot be left out silently.
  const engine = (await engineMigrations()).map((s) => s.component).sort();
  const all = (await discoverMigrations()).map((s) => s.component);
  for (const business of BUSINESS_SCHEMAS) {
    expect(all).toContain(business);
  }
  expect(engine).toEqual(all.filter((component) => !BUSINESS_SCHEMAS.includes(component)).sort());
});
