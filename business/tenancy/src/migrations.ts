import type { MigrationSet } from "@inspiration/kernel";

/** The tenancy schema. */
export const MIGRATIONS: MigrationSet = {
  component: "tenancy",
  directory: new URL("../migrations/", import.meta.url),
  order: 110,
};
