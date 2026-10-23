import type { AgentResult } from "@inspiration/contracts";
import { openPool } from "@inspiration/kernel";
import { hasStack, stackTest as test } from "@inspiration/testkit";
import { describe, expect } from "vitest";
import { PostgresRuns } from "../src/index.ts";

describe.skipIf(!hasStack())("run store on Postgres", () => {
  test("agent runs round-trip and a re-save updates the run", async ({ databaseUrl }) => {
    const pool = await openPool(databaseUrl);
    try {
      const runs = new PostgresRuns(pool);
      const now = new Date().toISOString();
      const result: AgentResult = {
        run_id: "run_01JC000000000000000000RUN1",
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
      await runs.save(result, { principalId: "agt_01JC000000000000000000AGT1" });
      await runs.save({ ...result, status: "completed" }, { principalId: "agt_01JC000000000000000000AGT1" });
      expect(await runs.get(result.run_id)).toEqual({ ...result, status: "completed" });
      expect(await runs.get("run_01JC0000000000000000MISSING")).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
