import type { MigrationSet } from "@inspiration/kernel";

/** The collaboration schema. */
export const MIGRATIONS: MigrationSet = {
  component: "collaboration",
  directory: new URL("../migrations/", import.meta.url),
  order: 80,
};
