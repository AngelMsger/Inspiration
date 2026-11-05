// Usage metering in Postgres and the shared response cache in Valkey, against the real stack.

import { openPool } from "@inspiration/kernel";
import { hasStack, stackTest as test } from "@inspiration/testkit";
import { describe, expect } from "vitest";
import { PostgresUsage, ValkeyCache } from "../src/index.ts";
import { completionRequest, makeGateway } from "./fixtures.ts";

describe.skipIf(!hasStack())("gateway on the stack", () => {
  test("usage is written and budgets sum it", async ({ databaseUrl }) => {
    const pool = await openPool(databaseUrl);
    try {
      const usage = new PostgresUsage(pool);
      const gateway = makeGateway({ usage });
      const key = "tenant:capped/extraction";
      const member = "mem_01QINGHE00000000000000LINA";
      const first = await gateway.complete(
        completionRequest("word ".repeat(200), { budget_key: key, member_id: member }),
      );
      await expect(gateway.complete(completionRequest("again", { budget_key: key }))).rejects.toMatchObject({
        code: "budget_exceeded",
      });
      const { rows } = await pool.query("SELECT * FROM gateway.usage ORDER BY at");
      expect(rows.map((r) => r.status)).toEqual(["ok", "budget_exceeded"]);
      expect(rows[0]).toMatchObject({
        request_id: first.request_id,
        provider: "cloud",
        task: "extraction.extract_claims",
        member_id: member,
        space_id: null,
      });
      expect(Number(rows[0].cost)).toBeCloseTo(first.cost.amount, 8);
      expect(await usage.spent(key, undefined)).toBeCloseTo(first.cost.amount, 8);
      expect(await usage.spent(key, new Date(Date.now() + 60_000))).toBe(0);
      expect(await usage.spent("tenant:other", undefined)).toBe(0);
      expect(await usage.spentMatching("tenant:*", undefined)).toBeCloseTo(first.cost.amount, 8);
      expect(await usage.spentMatching("tenant:other*", undefined)).toBe(0);
      // By day and by whom the calls are charged to: only rows of the tenant asked for.
      const day = new Date();
      const from = new Date(day.getTime() - 86_400_000);
      const until = new Date(day.getTime() + 86_400_000);
      expect(await usage.charges("ten_0000000X", from, until, "UTC")).toEqual([]);
      await gateway.complete(
        completionRequest("charged", {
          budget_key: "tenant:ten_0000000X/retrieval",
          tenant_id: "ten_0000000X",
          member_id: member,
        }),
      );
      const charged = await usage.charges("ten_0000000X", from, until, "UTC");
      expect(charged).toEqual([
        { date: day.toISOString().slice(0, 10), member_id: member, cost: expect.any(Number), calls: 1 },
      ]);
    } finally {
      await pool.end();
    }
  });

  test("the Valkey cache serves repeated completions across processes", async ({ valkey, streamPrefix }) => {
    const cache = new ValkeyCache(valkey, { prefix: streamPrefix });
    const gateway = makeGateway({ cache });
    await gateway.complete(completionRequest("cache me"));
    const again = await makeGateway({ cache }).complete(completionRequest("cache me")); // another process, same cache
    expect(again.cached).toBe(true);
    const keys = await valkey.keys(`${streamPrefix}:gw:cache:*`);
    expect(keys).toHaveLength(1);
    const ttl = await valkey.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(gateway.config.cache.ttl_s);
  });
});
