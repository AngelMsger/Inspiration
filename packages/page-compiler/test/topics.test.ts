import type { TaxonomyNode } from "@inspiration/contracts";
import { Sample } from "@inspiration/knowledge-store/testing";
import { describe, expect } from "vitest";
import { SECTIONS } from "../src/index.ts";
import { about, BACKENDS, SPACE, TENANT, topicsTest, type World } from "./fixtures.ts";

describe.each(BACKENDS)("topics on $backend", ({ backend, skip }) => {
  const test = topicsTest(backend);

  /** Three guides, each with a section on hotels, leave and payments. */
  const guides = async (w: World) => {
    for (const [i, name] of ["指南一", "指南二", "指南三"].entries()) {
      await w.doc(name, [
        { heading: "差旅住宿", sentences: about("差旅住宿", 3, 3 * i) },
        { heading: "年休假", sentences: about("年休假", 3, 3 * i) },
        { heading: "报销付款", sentences: about("报销付款", 3, 3 * i) },
      ]);
    }
  };

  test.skipIf(skip)(
    "sections of governed documents form named topics, and every statement is placed",
    async ({ world: w }) => {
      await guides(w);
      // Until the first clustering there are no topics, so every statement is unfiled.
      expect(await w.placement(about("差旅住宿", 1)[0] as string)).toBeUndefined();
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(9);

      const report = await w.topics.recluster(TENANT);
      expect(report).toMatchObject({ sections: 9, statements: 27, unfiled: 0, named: 3, model_calls: 1 });
      expect(report.placed).toEqual({ governed: 27, reference: 0, search_only: 0 });
      expect(report.topics).toMatchObject({ live: 3, by_level: { "1": 0, "2": 3, "3": 0 }, created: 3, retired: 0 });
      const nodes = await w.store.topics(TENANT, SPACE);
      expect(nodes.map((n) => [n.title, n.status, n.statement_count]).sort()).toEqual([
        ["差旅住宿", "proposed", 9],
        ["年休假", "proposed", 9],
        ["报销付款", "proposed", 9],
      ]);
      const hotel = nodes.find((n) => n.title === "差旅住宿");
      for (const s of about("差旅住宿", 9)) {
        expect((await w.placement(s))?.taxonomy_key).toBe(hotel?.key);
      }
      const p = await w.placement(about("差旅住宿", 1)[0] as string);
      expect(p).toMatchObject({ placed_by: "clustering", confirmed: false });
      expect(p?.score).toBeGreaterThan(0.5);
      expect(w.calls().filter((c) => c.task === "page-compiler.name_topics")).toHaveLength(1);

      // Nothing changed, so nothing moves and nothing is written.
      const again = await w.topics.recluster(TENANT);
      expect(again.churn).toEqual({ before: 27, moved: 0, deferred: 0 });
      expect(again.topics).toMatchObject({ live: 3, created: 0, retired: 0 });
      expect(again.model_calls).toBe(0);
      expect(await w.store.topics(TENANT, SPACE)).toEqual(nodes);
    },
  );

  test.skipIf(skip)("a topic keeps the owner it is given, and lists the documents it holds", async ({ world: w }) => {
    const OWNER = "mem_01JC000000000000000000LINA";
    await guides(w);
    await w.topics.recluster(TENANT);
    const hotel = (await w.store.topics(TENANT, SPACE)).find((n) => n.title === "差旅住宿") as TaxonomyNode;
    expect(await w.topics.setOwner(TENANT, hotel.key, OWNER)).toMatchObject({ key: hotel.key, owner_id: OWNER });
    await w.doc("指南四", [{ heading: "差旅住宿", sentences: about("差旅住宿", 3, 20) }]);
    await w.topics.recluster(TENANT);
    expect((await w.store.topics(TENANT, SPACE)).find((n) => n.key === hotel.key)?.owner_id).toBe(OWNER);

    const documents = (await w.topics.documentsIn(TENANT)).get(hotel.key) ?? [];
    expect(documents.map((d) => [d.title, d.sections, d.statements]).sort()).toEqual([
      ["指南一", 1, 3],
      ["指南三", 1, 3],
      ["指南二", 1, 3],
      ["指南四", 1, 3],
    ]);
    expect(await w.topics.setOwner(TENANT, hotel.key, undefined)).not.toHaveProperty("owner_id");
    await expect(w.topics.setOwner(TENANT, "t-missing", OWNER)).rejects.toThrow(RangeError);
  });

  test.skipIf(skip)(
    "a new section joins the nearest topic at once, and its statements leave with it",
    async ({ world: w }) => {
      await guides(w);
      await w.topics.recluster(TENANT);
      const leave = (await w.store.topics(TENANT, SPACE)).find((n) => n.title === "年休假");
      const added = about("年休假", 3, 20);
      const v1 = await w.doc("指南四", [{ heading: "年休假", sentences: added }]);
      for (const s of added) expect((await w.placement(s))?.taxonomy_key).toBe(leave?.key);
      const counted = async () =>
        (await w.store.topics(TENANT, SPACE)).find((n) => n.key === leave?.key)?.statement_count;
      expect(await counted()).toBe(12);

      // An edit removes one sentence: its statement leaves the topic.
      await w.doc("指南四", [{ heading: "年休假", sentences: added.slice(0, 2) }]);
      expect(await w.placement(added[2] as string)).toBeUndefined();
      expect(await counted()).toBe(11);

      await w.doc("指南四", [], { deleted: true });
      for (const s of added) expect(await w.placement(s)).toBeUndefined();
      expect(await counted()).toBe(9);
      // A late delivery of the first version reads the document as it is now: deleted.
      await w.topics.update(v1);
      expect(await counted()).toBe(9);
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(9);
    },
  );

  test.skipIf(skip)(
    "reference statements join their slot's topic; archived and search-only ones are never placed",
    async ({ world: w }) => {
      await w.doc("差旅指南", [
        { heading: "差旅住宿", sentences: [["一线城市住宿每晚不超过 600 元。", "hotel_cap"], ...about("差旅住宿", 5)] },
      ]);
      await w.doc("差旅问答", [
        { heading: "差旅住宿", sentences: [["住宿标准为每晚 600 元。", "hotel_cap"], ...about("差旅住宿", 5, 5)] },
      ]);
      await w.doc(
        "九月例会纪要",
        [{ heading: "议题", sentences: [["会议决定住宿每晚 650 元。", "hotel_cap"], "下次例会在十月召开。"] }],
        { level: "reference" },
      );
      await w.doc("旧差旅制度", [{ heading: "差旅住宿", sentences: [["住宿每晚 500 元。", "hotel_cap"]] }], {
        approval: "archived",
      });
      await w.doc("周报", [{ heading: "本周进展", sentences: ["完成住宿系统上线。"] }], { level: "search_only" });

      const report = await w.topics.recluster(TENANT);
      expect(report.placed).toEqual({ governed: 12, reference: 1, search_only: 0 });
      expect(report.unfiled).toBe(0);
      const hotel = (await w.placement("一线城市住宿每晚不超过 600 元。"))?.taxonomy_key;
      expect(hotel).toBeDefined();
      expect((await w.placement("会议决定住宿每晚 650 元。"))?.taxonomy_key).toBe(hotel);
      expect(await w.placement("下次例会在十月召开。")).toBeUndefined();
      expect(await w.placement("住宿每晚 500 元。")).toBeUndefined();
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(4);

      // A later reference statement of the slot is placed at once.
      await w.doc("十月例会纪要", [{ heading: "议题", sentences: [["住宿每晚调整为 700 元。", "hotel_cap"]] }], {
        level: "reference",
      });
      expect((await w.placement("住宿每晚调整为 700 元。"))?.taxonomy_key).toBe(hotel);
    },
  );

  test.skipIf(skip)(
    "confirmed topics and placements stay; topics left without statements retire",
    async ({ world: w }) => {
      await guides(w);
      await w.topics.recluster(TENANT);
      const nodes = await w.store.topics(TENANT, SPACE);
      const [hotel, leave, pay] = ["差旅住宿", "年休假", "报销付款"].map((t) => nodes.find((n) => n.title === t)) as [
        TaxonomyNode,
        TaxonomyNode,
        TaxonomyNode,
      ];
      // An owner renames and confirms the leave topic, and files one payment statement under hotels.
      const moved = about("报销付款", 1)[0] as string;
      const filed = new Sample().placement(await w.claim(moved), hotel.key, {
        placed_by: "member",
        member_id: "mem_01JC000000000000000000OWNER",
        confirmed: true,
      });
      await w.store.transaction(async (tx) => {
        await tx.putTopics([{ ...leave, status: "confirmed", title: "休假" }]);
        await tx.place([filed]);
      });

      // Every leave and payment section goes away.
      for (const [i, name] of ["指南一", "指南二", "指南三"].entries()) {
        await w.doc(name, [{ heading: "差旅住宿", sentences: about("差旅住宿", 3, 3 * i) }]);
      }
      const report = await w.topics.recluster(TENANT);
      const after = new Map((await w.store.topics(TENANT, SPACE)).map((n) => [n.key, n]));
      expect(after.get(leave.key)).toMatchObject({ status: "confirmed", title: "休假", statement_count: 0 });
      expect(after.get(pay.key)).toMatchObject({ status: "retired", statement_count: 0 });
      expect(after.get(hotel.key)?.statement_count).toBe(9);
      expect(report.topics).toMatchObject({ retired: 1, confirmed: 1 });
      // The member's placement is not the statement's any more: it was retracted with its section.
      expect((await w.claim(moved)).status).toBe("retracted");
      expect(await w.placement(moved)).toMatchObject({ placed_by: "member", taxonomy_key: hotel.key });
    },
  );

  test.skipIf(skip)(
    "names go to the model with the highest sensitivity of the topic's sections",
    async ({ world: w }) => {
      await w.doc("薪酬指南", [{ heading: "薪酬发放", sentences: about("薪酬发放", 3) }], {
        sensitivity: "confidential",
      });
      await w.doc("薪酬问答", [{ heading: "薪酬发放", sentences: about("薪酬发放", 3, 3) }]);
      await w.topics.recluster(TENANT);
      const naming = w.calls().filter((c) => c.task === "page-compiler.name_topics");
      expect(naming.map((c) => c.sensitivity)).toEqual(["confidential"]);
      // Embeddings carry each document's own label.
      expect(
        w
          .calls()
          .filter((c) => c.operation === "embed")
          .map((c) => c.sensitivity),
      ).toEqual(["confidential", "internal"]);
    },
  );
});
