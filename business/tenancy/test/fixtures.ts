import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { test } from "vitest";
import {
  type Company,
  type EngineDirectory,
  type Member,
  MemoryTenancy,
  type Person,
  PostgresTenancy,
  Tenancy,
} from "../src/index.ts";

export const BACKENDS = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
] as const;

/** The engine's directory as tenancy sees it: every call kept in order. */
export class FakeEngine implements EngineDirectory {
  readonly calls: (["tenant", Company] | ["member", Member])[] = [];
  failing = false;

  async putTenant(company: Company): Promise<void> {
    if (this.failing) throw new Error("the engine did not answer");
    this.calls.push(["tenant", company]);
  }

  async putMember(member: Member): Promise<void> {
    if (this.failing) throw new Error("the engine did not answer");
    this.calls.push(["member", member]);
  }

  /** The last record the engine got for a member. */
  member(memberId: string): Member | undefined {
    return this.calls.findLast((c): c is ["member", Member] => c[0] === "member" && c[1].id === memberId)?.[1];
  }
}

/** A clock the test moves by hand. */
export class Clock {
  now = new Date("2026-11-05T03:00:00.000Z");
  read = () => this.now;
  advance(days: number): void {
    this.now = new Date(this.now.getTime() + days * 24 * 60 * 60 * 1000);
  }
}

export const person = (name: string, n: number): Person => ({
  userId: `usr_01JC0000000000000000000${String(n).padStart(3, "0")}`,
  name,
  email: `${name.toLowerCase()}@example.com`,
});

export const ZHOU = person("Zhou", 1);
export const ZHANG = person("Zhang", 2);
export const LI = person("Li", 3);

export const tenancyTest = (backend: (typeof BACKENDS)[number]["backend"]) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("setup", async ({}, { onCleanup }) => {
    const engine = new FakeEngine();
    const clock = new Clock();
    if (backend === "memory") {
      return { tenancy: new Tenancy(new MemoryTenancy(), engine, { clock: clock.read }), engine, clock };
    }
    const db = await createTestDatabase();
    const pool = await openPool(db.url);
    onCleanup(async () => {
      await pool.end();
      await db.drop();
    });
    return { tenancy: new Tenancy(new PostgresTenancy(pool), engine, { clock: clock.read }), engine, clock };
  });
