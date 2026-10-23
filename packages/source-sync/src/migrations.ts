import type { MigrationSet } from "@inspiration/kernel";

/** The sync schema. */
export const MIGRATIONS: MigrationSet = {
  component: "sync",
  directory: new URL("../migrations/", import.meta.url),
  order: 40,
};
