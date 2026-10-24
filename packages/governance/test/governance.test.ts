import { describe, expect } from "vitest";
import { BACKENDS, governanceTest, HOTEL, SPACE, TENANT } from "./fixtures.ts";

const POLICY = { title: "差旅费管理办法", authority: 0.9, effective_from: "2026-01-01" };
const GUIDE = { title: "新人入职指南", authority: 0.5 };

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("governance", () => {
    test("a dated change outranks the policy until it is revised; archived values settle alone", async ({ world }) => {
      const policy = await world.state(POLICY, [{ text: "一线城市住宿限额为每晚 600 元。", value: 600 }]);
      expect(policy.result.requests).toEqual([]);
      const archive = await world.state(
        {
          title: "差旅费管理办法（2023 版）",
          authority: 0.3,
          approval_state: "archived",
          effective_from: "2023-03-01",
        },
        [{ text: "一线城市住宿限额为每晚 500 元。", value: 500 }],
      );
      expect(archive.result).toEqual({ slots: [HOTEL], requests: [] });
      await world.state({ title: "常见问题", authority: 0.5 }, [{ text: "北京出差住宿每晚 600 元。", value: 600 }]);
      const notice = await world.state({ title: "关于调整一线城市住宿标准的通知", authority: 0.5 }, [
        { text: "自 2026 年 10 月 1 日起，住宿限额由每晚 600 元调整为每晚 650 元。", value: 650, from: "2026-10-01" },
      ]);

      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("650 CNY/night");
      expect(decision?.basis).toBe("changed");
      const cases = await world.governance.conflicts(TENANT);
      expect(Object.fromEntries(cases.map((c) => [c.rationale?.split(" ")[0], [c.classification, c.status]]))).toEqual({
        "600": ["supersession", "open"],
        Only: ["supersession", "auto_resolved"],
      });
      expect(cases.every((c) => c.proposed_winner_id === notice.claims[0]?.id && c.tier === "deterministic")).toBe(
        true,
      );

      expect(await world.requests()).toEqual([
        {
          kind: "conflict",
          space_id: SPACE,
          title: "hotel_cap_per_night (一线城市): 650 CNY/night or 600 CNY/night",
          detail: [
            "- **650 CNY/night**, proposed (changed on 2026-10-01 in 关于调整一线城市住宿标准的通知): 1 statement in 1 document, the most authoritative 关于调整一线城市住宿标准的通知.",
            "- 600 CNY/night, supersession: 2 statements in 2 documents, the most authoritative 差旅费管理办法. 600 CNY/night (2 documents, the most authoritative 差旅费管理办法) predates the change to 650 CNY/night on 2026-10-01 in 关于调整一线城市住宿标准的通知.",
          ].join("\n"),
          priority: "high",
          unit_ids: [notice.claims[0]?.id, policy.claims[0]?.id],
          dedupe_key: "governance:conflict:hotel_cap_per_night|一线城市",
          batch_key: "governance:conflict:hotel_cap_per_night",
        },
      ]);
    });

    test("a document that takes effect later does not change the current value before then", async ({ world }) => {
      const current = await world.state({ title: "差旅费管理办法", authority: 0.8, effective_from: "2026-01-01" }, [
        { text: "一线城市住宿限额为每晚 600 元。", value: 600 },
      ]);
      // The new edition's claims take its effective date, as extraction gives them.
      await world.state({ title: "差旅费管理办法（2027 版）", authority: 0.9, effective_from: "2027-01-01" }, [
        { text: "一线城市住宿限额为每晚 700 元。", value: 700 },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.proposed.best.claim_id).toBe(current.claims[0]?.id);
      expect(decision?.cases).toMatchObject([
        {
          value: "700 CNY/night",
          classification: "plan_vs_fact",
          priority: "low",
          rationale: "700 CNY/night takes effect on 2027-01-01.",
        },
      ]);
    });

    test("a contradiction proposes the more authoritative source and asks once", async ({ world }) => {
      const policy = await world.state(POLICY, [{ text: "一线城市住宿限额为每晚 600 元。", value: 600 }]);
      const guide = await world.state(GUIDE, [{ text: "去北京出差，住宿每晚 700 元以内。", value: 700 }]);
      expect(guide.result.requests).toMatchObject([
        { title: "hotel_cap_per_night (一线城市): 600 CNY/night or 700 CNY/night", priority: "normal" },
      ]);
      expect(guide.result.requests[0]?.unit_ids).toEqual([policy.claims[0]?.id, guide.claims[0]?.id]);
      const [conflict] = await world.governance.conflicts(TENANT);
      expect(conflict).toMatchObject({ classification: "contradiction", status: "open", batch_key: HOTEL });

      // Another document repeating a known value changes counts, not the decision.
      const again = await world.state({ title: "新人入职指南（第 2 版）", authority: 0.5 }, [
        { text: "北京住宿每晚 700 元。", value: 700 },
      ]);
      expect(again.result).toEqual({ slots: [HOTEL], requests: [] });
      const groups = (await world.governance.slot(TENANT, HOTEL)).groups;
      expect(Object.fromEntries(groups.map((g) => [g.value, [g.count, g.versions.length]]))).toEqual({
        "600 CNY/night": [1, 1],
        "700 CNY/night": [2, 2],
      });

      // A redelivered update is a no-op.
      expect(await world.governance.apply(again.event)).toEqual({ slots: [], requests: [] });
      expect((await world.governance.slot(TENANT, HOTEL)).groups.find((g) => g.value === "700 CNY/night")?.count).toBe(
        2,
      );
      expect(await world.requests()).toHaveLength(1);
    });

    test("plans and later dates do not override what is in force", async ({ world }) => {
      await world.state(POLICY, [{ text: "一线城市住宿限额为每晚 600 元。", value: 600 }]);
      await world.state({ title: "2027 年预算方案", authority: 0.5 }, [
        { text: "计划将一线城市住宿限额提高到每晚 800 元。", value: 800, type: "plan" },
      ]);
      await world.state({ title: "关于 2027 年住宿标准的通知", authority: 0.5 }, [
        { text: "自 2027 年 1 月 1 日起，住宿限额调整为每晚 700 元。", value: 700, from: "2027-01-01" },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases.map((c) => [c.value, c.classification, c.priority, c.rationale])).toEqual([
        ["700 CNY/night", "plan_vs_fact", "low", "700 CNY/night takes effect on 2027-01-01."],
        ["800 CNY/night", "plan_vs_fact", "low", "Only plans state 800 CNY/night."],
      ]);
    });

    test("the latest change in effect wins, even when the same value is announced again for later", async ({
      world,
    }) => {
      await world.state(POLICY, [{ text: "一线城市住宿限额为每晚 600 元。", value: 600 }]);
      const notice = (title: string, value: number, from: string) =>
        world.state({ title, authority: 0.5 }, [
          { text: `自 ${from} 起，住宿限额调整为每晚 ${value} 元。`, value, from },
        ]);
      await notice("六月通知", 650, "2026-06-01");
      const august = await notice("八月通知", 700, "2026-08-01");
      await notice("明年通知", 700, "2027-01-01");
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect([decision?.proposed.value, decision?.basis, decision?.change?.claim_id]).toEqual([
        "700 CNY/night",
        "changed",
        august.claims[0]?.id,
      ]);
      expect(decision?.cases.map((c) => [c.value, c.classification])).toEqual([
        ["600 CNY/night", "supersession"],
        ["650 CNY/night", "supersession"],
      ]);
    });

    test("a conflict whose statements go away settles, and asks again when it comes back", async ({ world }) => {
      await world.state(POLICY, [{ text: "一线城市住宿限额为每晚 600 元。", value: 600 }]);
      const guide = await world.state(GUIDE, [{ text: "去北京出差，住宿每晚 700 元以内。", value: 700 }]);
      expect(guide.result.requests).toHaveLength(1);

      const closed = await world.close(guide.claims);
      expect(closed).toEqual({ slots: [HOTEL], requests: [] });
      expect((await world.governance.conflicts(TENANT)).map((c) => [c.status, c.rationale])).toEqual([
        ["auto_resolved", "No longer in conflict."],
      ]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect([groups.map((g) => g.value), decision]).toEqual([["600 CNY/night"], undefined]);

      const back = await world.state({ title: "新人入职指南（修订）", authority: 0.5 }, [
        { text: "北京住宿每晚 700 元。", value: 700 },
      ]);
      expect(back.result.requests).toHaveLength(1);
      expect(await world.governance.conflicts(TENANT, "open")).toHaveLength(1);
    });
  });
});
