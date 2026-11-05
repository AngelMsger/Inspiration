import type { MigrationSet } from "@inspiration/kernel";

/** The accounts schema. */
export const MIGRATIONS: MigrationSet = {
  component: "accounts",
  directory: new URL("../migrations/", import.meta.url),
  order: 100,
};
