import type { MigrationSet } from "@inspiration/kernel";

/** The access_grants schema. */
export const MIGRATIONS: MigrationSet = {
  component: "access-grants",
  directory: new URL("../migrations/", import.meta.url),
  order: 120,
};
