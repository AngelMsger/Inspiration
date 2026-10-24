import type { MigrationSet } from "@inspiration/kernel";

/** The normalization schema. */
export const MIGRATIONS: MigrationSet = {
  component: "normalization",
  directory: new URL("../migrations/", import.meta.url),
  order: 55,
};
