import type { MigrationSet } from "@inspiration/kernel";

/** The extraction schema. */
export const MIGRATIONS: MigrationSet = {
  component: "extraction",
  directory: new URL("../migrations/", import.meta.url),
  order: 57,
};
