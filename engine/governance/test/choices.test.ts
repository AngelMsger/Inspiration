// A person's choice on a conflict todo: it settles the slot while governance would ask the same
// question, and governance asks again once it would not.

import type { TodoRequested } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { BACKENDS, governanceTest, HOTEL, LI, TENANT, type World } from "./fixtures.ts";

/** The travel policy says 600 and the sales handbook 650: an open contradiction, 600 proposed. */
async function contradiction(world: World): Promise<TodoRequested> {
  await world.state({ title: "Travel policy", authority: 0.9 }, [
    { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
  ]);
  await world.state({ title: "Sales handbook", authority: 0.6 }, [
    { text: "Hotels in tier-1 cities: 650 yuan a night.", value: 650 },
  ]);
  const requests = await world.requests();
  expect(requests.map((r) => r.resolutions?.map((o) => o.label))).toEqual([
    ["Keep 600 CNY/night", "Choose 650 CNY/night"],
  ]);
  return requests[0] as TodoRequested;
}

const standings = async (world: World) => {
  const [verdict] = await world.governance.verdicts(TENANT, [HOTEL]);
  return {
    held: verdict?.held_value,
    disputed: verdict?.disputed,
    values: verdict?.values.map((v) => [v.value, v.standing]),
    chosen_by: verdict?.chosen_by,
  };
};

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("a person's choice", () => {
    test("holds the value chosen over the one governance proposed, and asks nothing more", async ({ world }) => {
      const request = await contradiction(world);
      expect(await standings(world)).toEqual({
        held: "600 CNY/night",
        disputed: true,
        values: [
          ["600 CNY/night", "holds"],
          ["650 CNY/night", "disputed"],
        ],
        chosen_by: undefined,
      });

      const { event, result } = await world.resolve(request, { value: "650 CNY/night" });
      expect(result).toEqual({ slots: [HOTEL], requests: [], notes: [], withdrawn: [] });
      expect(await standings(world)).toEqual({
        held: "650 CNY/night",
        disputed: false,
        values: [
          ["650 CNY/night", "holds"],
          ["600 CNY/night", "outdated"],
        ],
        chosen_by: LI,
      });
      const [conflict] = await world.governance.conflicts(TENANT);
      expect(conflict).toMatchObject({ classification: "contradiction", status: "resolved" });
      expect(conflict?.rationale).toBe("650 CNY/night was chosen over 600 CNY/night on 2026-10-23.");

      // Delivered again, or decided again on a later day, nothing changes.
      expect((await world.governance.resolved(event)).slots).toEqual([]);
      world.setToday("2026-10-30");
      await world.governance.recheck(TENANT);
      // Another document repeating a value the person saw asks the same question.
      await world.state({ title: "FAQ", authority: 0.5 }, [
        { text: "Tier-1 city hotels are capped at 600 yuan.", value: 600 },
      ]);
      expect((await standings(world)).held).toBe("650 CNY/night");
      expect(await world.requests()).toHaveLength(1);
    });

    test("confirming the proposed value resolves its open cases and keeps what governance settled alone", async ({
      world,
    }) => {
      const request = await contradiction(world);
      await world.state({ title: "Travel policy (2023 edition)", authority: 0.3, approval_state: "archived" }, [
        { text: "The hotel cap in tier-1 cities is 500 yuan a night.", value: 500 },
      ]);
      await world.resolve(request, { value: "600 CNY/night" });
      const cases = await world.governance.conflicts(TENANT);
      expect(cases.map((c) => [c.rationale?.split(" ")[0], c.classification, c.status]).sort()).toEqual([
        ["600", "contradiction", "resolved"],
        ["Only", "supersession", "auto_resolved"],
      ]);
      expect((await standings(world)).values).toEqual([
        ["600 CNY/night", "holds"],
        ["500 CNY/night", "outdated"],
        ["650 CNY/night", "outdated"],
      ]);
    });

    test("lapses when governance would ask another question, and governance asks it", async ({ world }) => {
      const request = await contradiction(world);
      await world.resolve(request, { value: "650 CNY/night" });
      await world.state({ title: "Finance memo", authority: 0.9 }, [
        { text: "The hotel cap in tier-1 cities is 700 yuan a night.", value: 700 },
      ]);
      const asked = await world.requests();
      expect(asked).toHaveLength(2);
      expect(asked[1]?.title).toMatch(/: .+ or .+ or /);
      const now = await standings(world);
      expect([now.disputed, now.chosen_by]).toEqual([true, undefined]);
    });

    test("on a question no longer asked asks the current one; a dismissed todo is not asked again", async ({
      world,
    }) => {
      const first = await contradiction(world);
      await world.state({ title: "Finance memo", authority: 0.9 }, [
        { text: "The hotel cap in tier-1 cities is 700 yuan a night.", value: 700 },
      ]);
      const second = (await world.requests())[1] as TodoRequested;
      // The todo the person answered was replaced before the answer arrived.
      const late = await world.resolve(first, { value: "650 CNY/night" });
      expect(late.result.requests).toEqual([{ ...second }]);
      expect((await standings(world)).chosen_by).toBeUndefined();

      const dismissed = await world.resolve(second, { status: "dismissed" });
      expect(dismissed.result.requests).toEqual([]);
      expect((await standings(world)).disputed).toBe(true);
    });

    test("ignores todos governance did not ask for", async ({ world }) => {
      const request = await contradiction(world);
      const { result } = await world.resolve({ ...request, kind: "note" }, { value: "650 CNY/night" });
      expect(result.slots).toEqual([]);
      expect((await standings(world)).held).toBe("600 CNY/night");
    });
  });
});
