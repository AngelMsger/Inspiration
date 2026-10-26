import type { AgentResult, Principal } from "@inspiration/contracts";
import { openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { MemoryRuns, PostgresRuns, type RunStore } from "../src/index.ts";

const BACKENDS = [
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
] as const;

const runsTest = (backend: (typeof BACKENDS)[number]["backend"]) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("runs", async ({}, { onCleanup }): Promise<{ store: RunStore; sql?: (q: string) => Promise<void> }> => {
    if (backend === "memory") return { store: new MemoryRuns() };
    const db = await createTestDatabase();
    const pool = await openPool(db.url);
    onCleanup(async () => {
      await pool.end();
      await db.drop();
    });
    return {
      store: new PostgresRuns(pool),
      sql: async (q) => {
        await pool.query(q);
      },
    };
  });

function run(id: string): AgentResult {
  const now = "2026-10-24T01:00:00.000Z";
  return {
    run_id: id,
    agent: "collaboration.comment_assistant",
    agent_version: "0.1.0",
    status: "needs_approval",
    output: { reply: "ok" },
    steps: [],
    proposal_ids: ["prp_01JC000000000000000000PRP1"],
    usage: { input_tokens: 10, output_tokens: 2 },
    cost: { amount: 0.001, currency: "CNY" },
    trace_id: "trace-1",
    started_at: now,
    finished_at: now,
  };
}

// One person with the same member ID in two tenants, through an agent in each.
const MEMBER = "mem_01JC000000000000000000MEM1";
const agentIn = (tenant: string): Principal => ({
  id: "agt_01JC000000000000000000AGT1",
  kind: "agent",
  tenant_id: tenant,
  on_behalf_of: MEMBER,
});
const A = "ten_01JC0000000000000000000TENA";
const B = "ten_01JC0000000000000000000TENB";

describe.each(BACKENDS)("run store on $backend", ({ backend, skip }) => {
  const it = runsTest(backend);

  it.skipIf(skip)("a run is found only in its own tenant, with who it ran as", async ({ runs }) => {
    const inA = run("run_01JC00000000000000000RUNA");
    const inB = run("run_01JC00000000000000000RUNB");
    await runs.store.save(inA, agentIn(A));
    await runs.store.save(inB, agentIn(B));
    // A re-save updates the run.
    await runs.store.save({ ...inA, status: "completed" }, agentIn(A));

    expect(await runs.store.get(A, inA.run_id)).toEqual({
      tenant_id: A,
      principal: "agt_01JC000000000000000000AGT1",
      on_behalf_of: MEMBER,
      result: { ...inA, status: "completed" },
    });
    expect(await runs.store.get(B, inA.run_id)).toBeUndefined();
    expect((await runs.store.get(B, inB.run_id))?.tenant_id).toBe(B);
    expect(await runs.store.get(A, "run_01JC0000000000000000MISSING")).toBeUndefined();
    expect((await runs.store.getAcrossTenants(inB.run_id))?.tenant_id).toBe(B);

    if (runs.sql) {
      // Runs saved before runs recorded their tenant are found only across tenants.
      await runs.sql(
        `INSERT INTO agents.runs (run_id, agent, version, status, trace_id, principal, started_at, finished_at, result)
         VALUES ('run_01JC0000000000000000LEGACY', 'a', '1', 'completed', 't', 'agt_01JC000000000000000000AGT1',
                 now(), now(), '${JSON.stringify(run("run_01JC0000000000000000LEGACY"))}')`,
      );
      expect(await runs.store.get(A, "run_01JC0000000000000000LEGACY")).toBeUndefined();
      expect(await runs.store.getAcrossTenants("run_01JC0000000000000000LEGACY")).toEqual({
        principal: "agt_01JC000000000000000000AGT1",
        result: run("run_01JC0000000000000000LEGACY"),
      });
    }
  });
});
