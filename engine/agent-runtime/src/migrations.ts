import type { MigrationSet } from "@inspiration/kernel";

/** The agents schema. */
export const MIGRATIONS: MigrationSet = {
  component: "agents",
  directory: new URL("../migrations/", import.meta.url),
  order: 40,
};
