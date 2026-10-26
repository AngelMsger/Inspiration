import type { MigrationSet } from "@inspiration/kernel";

/** The governance schema. */
export const MIGRATIONS: MigrationSet = {
  component: "governance",
  directory: new URL("../migrations/", import.meta.url),
  order: 65,
};
