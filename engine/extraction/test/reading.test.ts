import { type ClaimsUpdated, payloadOf } from "@inspiration/contracts";
import { type BudgetConfig, type FakeProvider, ProviderError } from "@inspiration/model-gateway";
import { describe, expect } from "vitest";
import { BACKENDS, extractionTest, type Para, TENANT, type World } from "./fixtures.ts";

const POLICY: Para[] = [
  { id: "p1", text: "Hotels in tier-1 cities cost at most 600 yuan a night." },
  { id: "p2", text: "Travel expense claims must be filed within 30 days after the trip." },
];

/** A company day budget of nothing, until the returned function lifts it, as the next day does. */
function spendBudget(world: World): () => void {
  const spent: BudgetConfig = { match: "tenant:*/extraction", period: "day", limit: 0 };
  world.gateway.config.budgets.unshift(spent);
  return () => world.gateway.config.budgets.splice(world.gateway.config.budgets.indexOf(spent), 1);
}

const updates = async (world: World) =>
  (await world.events())
    .filter((e) => e.type === "claims.updated")
    .map((e) => payloadOf(e, "claims.updated") as ClaimsUpdated);

describe.each(BACKENDS)("$backend store", ({ backend, skip }) => {
  const test = extractionTest(backend);

  describe.skipIf(skip)("reading stops at a budget or an outage", () => {
    test("a spent budget pauses reading, and resume reads on once it renews", async ({ world }) => {
      const renew = spendBudget(world);
      const { change, result } = await world.version("travel-policy.md", POLICY);
      expect(result).toMatchObject({ paused: true, added: [] });
      const [mark] = await world.extraction.documents(TENANT);
      expect(mark).toMatchObject({ reading: true, paused: { change, code: "budget_exceeded" } });
      expect(await updates(world)).toEqual([]);

      // Still spent: the document waits, from the same first stop.
      expect(await world.extraction.resume()).toBe(0);
      expect((await world.extraction.documents(TENANT))[0]?.paused?.at).toBe(mark?.paused?.at);

      renew();
      expect(await world.extraction.resume()).toBe(1);
      const [read] = await world.extraction.documents(TENANT);
      expect(read?.reading).toBeUndefined();
      expect(read?.paused).toBeUndefined();
      const [update] = await updates(world);
      const claims = await world.store.getClaims(update?.added ?? []);
      expect(claims.map((c) => c.statement).sort()).toEqual(POLICY.map((p) => p.text).sort());
      expect(await world.extraction.resume()).toBe(0);
    });

    test("a version that comes while reading is paused is read with what the pause left", async ({ world }) => {
      const renew = spendBudget(world);
      await world.version("travel-policy.md", POLICY);
      renew();
      // The new version changes only the second passage; the first was never read.
      const edited = [POLICY[0] as Para, { id: "p2", text: "Travel expense claims must be filed within 20 days." }];
      const { change, result } = await world.version("travel-policy.md", edited);
      expect(change.changed_block_ids).toHaveLength(1);
      expect(result.paused).toBeUndefined();
      const claims = await world.store.getClaims(result.added);
      expect(claims.map((c) => c.statement).sort()).toEqual(edited.map((p) => p.text).sort());
    });

    test("a model out of reach pauses reading the same way", async ({ world }) => {
      const providers = ["cloud", "local"].map((name) => world.gateway.provider<FakeProvider>(name));
      for (const p of providers) p.failWith = new ProviderError("connection refused", { retryable: true });
      const { result } = await world.version("travel-policy.md", POLICY);
      expect(result.paused).toBe(true);
      expect((await world.extraction.documents(TENANT))[0]?.paused?.code).toBe("provider_error");
      for (const p of providers) p.failWith = undefined;
      expect(await world.extraction.resume()).toBe(1);
      expect((await world.extraction.documents(TENANT))[0]).not.toHaveProperty("reading");
    });

    test("once one document of a company stops again, its others wait for the next pass", async ({ world }) => {
      spendBudget(world);
      await world.version("first.md", [POLICY[0] as Para]);
      await world.version("second.md", [POLICY[1] as Para]);
      const calls = world.routed().length;
      expect(await world.extraction.resume()).toBe(0);
      // The first document asked once and stopped; the second was not tried.
      expect(world.routed().length).toBe(calls + 1);
    });
  });
});
