import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import { AccessGrants, type Holder, MemoryGrants, PostgresGrants } from "../src/index.ts";

export const BACKENDS = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
] as const;

/** A clock the test moves by hand. */
export class Clock {
  now = new Date("2026-11-05T07:00:00.000Z");
  read = () => this.now;
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

const TENANT = "ten_01QINGHE000000000000000001";
export const ZHOU: Holder = { tenant_id: TENANT, id: "mem_01JC000000000000000000001", role: "super_admin" };
export const ZHANG: Holder = { tenant_id: TENANT, id: "mem_01JC000000000000000000002", role: "member" };
export const LI: Holder = { tenant_id: TENANT, id: "mem_01JC000000000000000000003", role: "member" };

export const grantsTest = (backend: (typeof BACKENDS)[number]["backend"]) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("setup", async ({}, { onCleanup }) => {
    const clock = new Clock();
    if (backend === "memory") return { grants: new AccessGrants(new MemoryGrants(), { clock: clock.read }), clock };
    const db = await createTestDatabase();
    const pool = await openPool(db.url);
    onCleanup(async () => {
      await pool.end();
      await db.drop();
    });
    return { grants: new AccessGrants(new PostgresGrants(pool), { clock: clock.read }), clock };
  });
