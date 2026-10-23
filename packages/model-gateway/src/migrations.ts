import type { MigrationSet } from "@inspiration/kernel";

/** The gateway schema. */
export const MIGRATIONS: MigrationSet = {
  component: "gateway",
  directory: new URL("../migrations/", import.meta.url),
  order: 20,
};
