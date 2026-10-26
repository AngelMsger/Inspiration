import type { MigrationSet } from "@inspiration/kernel";

/** The page_compiler schema. */
export const MIGRATIONS: MigrationSet = {
  component: "page-compiler",
  directory: new URL("../migrations/", import.meta.url),
  order: 75,
};
