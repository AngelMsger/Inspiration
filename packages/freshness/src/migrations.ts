import type { MigrationSet } from "@inspiration/kernel";

/** The freshness schema. */
export const MIGRATIONS: MigrationSet = {
  component: "freshness",
  directory: new URL("../migrations/", import.meta.url),
  order: 70,
};
