import type { MigrationSet } from "@inspiration/kernel";

/** The kb schema. */
export const MIGRATIONS: MigrationSet = {
  component: "kb",
  directory: new URL("../migrations/", import.meta.url),
  order: 30,
};
