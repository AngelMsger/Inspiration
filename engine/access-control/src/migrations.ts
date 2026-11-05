import type { MigrationSet } from "@inspiration/kernel";

/** The authz schema: the directory copy and the spaces. */
export const MIGRATIONS: MigrationSet = {
  component: "authz",
  directory: new URL("../migrations/", import.meta.url),
  order: 35,
};
