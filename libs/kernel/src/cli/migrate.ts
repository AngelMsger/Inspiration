#!/usr/bin/env node
// Apply every pending migration of the installed components.
//
// Usage: inspiration-migrate [--database-url URL] [--list]

import { parseArgs } from "node:util";
import { applyMigrations, discoverMigrations, migrationFiles } from "../migrate.ts";
import { getSettings } from "../settings.ts";

const { values } = parseArgs({
  options: {
    "database-url": { type: "string" },
    list: { type: "boolean", default: false },
  },
});

if (values.list) {
  for (const set of await discoverMigrations()) {
    console.log(
      `${set.component}: ${migrationFiles(set)
        .map(([v]) => v)
        .join(", ")}`,
    );
  }
} else {
  const applied = await applyMigrations(values["database-url"] ?? getSettings().databaseUrl);
  console.log(applied.length ? `migrate: applied ${applied.join(", ")}` : "migrate: up to date");
}
