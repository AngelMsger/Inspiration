import type { MigrationSet } from "@inspiration/kernel";

/** The bus schema. */
export const MIGRATIONS: MigrationSet = {
  component: "bus",
  directory: new URL("../migrations/", import.meta.url),
  order: 10,
};
