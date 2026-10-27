import type { MigrationSet } from "@inspiration/kernel";

/** The retrieval schema. */
export const MIGRATIONS: MigrationSet = {
  component: "retrieval",
  directory: new URL("../migrations/", import.meta.url),
  order: 77,
};
