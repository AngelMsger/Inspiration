import type { TaxonomyNode } from "@inspiration/contracts";
import { Sample } from "@inspiration/knowledge-store/testing";
import { describe, expect } from "vitest";
import { PENDING, SECTIONS, Topics } from "../src/index.ts";
import { about, BACKENDS, SPACE, TENANT, topicsTest, type World } from "./fixtures.ts";

/** The world's store and records, with the nth transaction across them lost before it commits. */
function losing(w: World, nth: number) {
  const kinds: string[] = [];
  const lose = <T extends object>(target: T, kind: string): T =>
    new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop);
        if (typeof v !== "function") return v;
        if (prop !== "transaction") return v.bind(t);
        return (fn: unknown) => {
          kinds.push(kind);
          return kinds.length === nth ? Promise.reject(new Error("lost")) : v.call(t, fn);
        };
      },
    });
  return { store: lose(w.store, "store"), records: lose(w.records, "records"), kinds: () => kinds };
}

describe.each(BACKENDS)("topics on $backend", ({ backend, skip }) => {
  const test = topicsTest(backend);

  /** Three guides, each with a section on hotels, leave and payments. */
  const guides = async (w: World) => {
    for (const [i, name] of ["Guide 1", "Guide 2", "Guide 3"].entries()) {
      await w.doc(name, [
        { heading: "Hotel lodging", sentences: about("Hotel lodging", 3, 3 * i) },
        { heading: "Annual leave", sentences: about("Annual leave", 3, 3 * i) },
        { heading: "Expense payment", sentences: about("Expense payment", 3, 3 * i) },
      ]);
    }
  };

  test.skipIf(skip)(
    "sections of governed documents form named topics, and every statement is placed",
    async ({ world: w }) => {
      await guides(w);
      // Until the first clustering there are no topics, so every statement is unfiled.
      expect(await w.placement(about("Hotel lodging", 1)[0] as string)).toBeUndefined();
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(9);

      const report = await w.topics.recluster(TENANT);
      expect(report).toMatchObject({ sections: 9, statements: 27, unfiled: 0, named: 3, model_calls: 1 });
      expect(report.placed).toEqual({ governed: 27, reference: 0, search_only: 0 });
      expect(report.topics).toMatchObject({ live: 3, by_level: { "1": 0, "2": 3, "3": 0 }, created: 3, retired: 0 });
      const nodes = await w.store.topics(TENANT, SPACE);
      expect(nodes.map((n) => [n.title, n.status, n.statement_count]).sort()).toEqual([
        ["Annual leave", "proposed", 9],
        ["Expense payment", "proposed", 9],
        ["Hotel lodging", "proposed", 9],
      ]);
      const hotel = nodes.find((n) => n.title === "Hotel lodging");
      for (const s of about("Hotel lodging", 9)) {
        expect((await w.placement(s))?.taxonomy_key).toBe(hotel?.key);
      }
      const p = await w.placement(about("Hotel lodging", 1)[0] as string);
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
    const hotel = (await w.store.topics(TENANT, SPACE)).find((n) => n.title === "Hotel lodging") as TaxonomyNode;
    expect(await w.topics.setOwner(TENANT, hotel.key, OWNER)).toMatchObject({ key: hotel.key, owner_id: OWNER });
    await w.doc("Guide 4", [{ heading: "Hotel lodging", sentences: about("Hotel lodging", 3, 20) }]);
    await w.topics.recluster(TENANT);
    expect((await w.store.topics(TENANT, SPACE)).find((n) => n.key === hotel.key)?.owner_id).toBe(OWNER);

    const documents = (await w.topics.documentsIn(TENANT)).get(hotel.key) ?? [];
    expect(documents.map((d) => [d.title, d.sections, d.statements]).sort()).toEqual([
      ["Guide 1", 1, 3],
      ["Guide 2", 1, 3],
      ["Guide 3", 1, 3],
      ["Guide 4", 1, 3],
    ]);
    expect(await w.topics.setOwner(TENANT, hotel.key, undefined)).not.toHaveProperty("owner_id");
    await expect(w.topics.setOwner(TENANT, "t-missing", OWNER)).rejects.toThrow(RangeError);
  });

  test.skipIf(skip)(
    "a new section joins the nearest topic at once, and its statements leave with it",
    async ({ world: w }) => {
      await guides(w);
      await w.topics.recluster(TENANT);
      const leave = (await w.store.topics(TENANT, SPACE)).find((n) => n.title === "Annual leave");
      const added = about("Annual leave", 3, 20);
      const v1 = await w.doc("Guide 4", [{ heading: "Annual leave", sentences: added }]);
      for (const s of added) expect((await w.placement(s))?.taxonomy_key).toBe(leave?.key);
      const counted = async () =>
        (await w.store.topics(TENANT, SPACE)).find((n) => n.key === leave?.key)?.statement_count;
      expect(await counted()).toBe(12);

      // An edit removes one sentence: its statement leaves the topic.
      await w.doc("Guide 4", [{ heading: "Annual leave", sentences: added.slice(0, 2) }]);
      expect(await w.placement(added[2] as string)).toBeUndefined();
      expect(await counted()).toBe(11);

      await w.doc("Guide 4", [], { deleted: true });
      for (const s of added) expect(await w.placement(s)).toBeUndefined();
      expect(await counted()).toBe(9);
      // A late delivery of the first version reads the document as it is now: deleted.
      await w.topics.update(v1);
      expect(await counted()).toBe(9);
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(9);
    },
  );

  test.skipIf(skip)(
    "an update that fails between its writes is finished by the next one, which counts each statement once",
    async ({ world: w }) => {
      await guides(w);
      await w.topics.recluster(TENANT);
      const leave = (await w.store.topics(TENANT, SPACE)).find((n) => n.title === "Annual leave") as TaxonomyNode;
      const counted = async () =>
        (await w.store.topics(TENANT, SPACE)).find((n) => n.key === leave.key)?.statement_count;
      const added = about("Annual leave", 5, 20);
      // Each edit loses one of its three commits: the sections with the store writes they call
      // for, the store writes, and forgetting them. Then claims.updated comes again, twice.
      for (const [lost, sentences, before, after] of [
        [1, added.slice(0, 3), 9, 12],
        [2, added.slice(0, 2), 12, 11],
        [3, [...added.slice(0, 2), ...added.slice(3)], 13, 13],
      ] as const) {
        const v = await w.doc("leave-guide", [{ heading: "Annual leave", sentences: [...sentences] }], {
          update: false,
        });
        const failing = losing(w, lost);
        await expect(
          new Topics({ store: failing.store, records: failing.records, models: w.gateway }).update(v),
        ).rejects.toThrow("lost");
        expect(failing.kinds()).toEqual(["records", "store", "records"].slice(0, lost));
        expect(await counted()).toBe(before);
        await w.topics.update(v);
        await w.topics.update(v);
        expect(await counted()).toBe(after);
        for (const s of sentences) expect((await w.placement(s))?.taxonomy_key).toBe(leave.key);
      }
      expect(await w.records.count(PENDING, { tenant_id: TENANT })).toBe(0);
      expect((await w.topics.recluster(TENANT)).churn.moved).toBe(0);
      expect(await counted()).toBe(13);
    },
  );

  test.skipIf(skip)(
    "reference statements join their slot's topic; archived and search-only ones are never placed",
    async ({ world: w }) => {
      await w.doc("Travel guide", [
        {
          heading: "Hotel lodging",
          sentences: [
            ["Hotels in tier-1 cities cost no more than 600 yuan a night.", "hotel_cap"],
            ...about("Hotel lodging", 5),
          ],
        },
      ]);
      await w.doc("Travel FAQ", [
        {
          heading: "Hotel lodging",
          sentences: [["The hotel rate is 600 yuan a night.", "hotel_cap"], ...about("Hotel lodging", 5, 5)],
        },
      ]);
      await w.doc(
        "September meeting minutes",
        [
          {
            heading: "Agenda",
            sentences: [
              ["The meeting set hotels at 650 yuan a night.", "hotel_cap"],
              "The next meeting is in October.",
            ],
          },
        ],
        { level: "reference" },
      );
      await w.doc(
        "Old travel policy",
        [{ heading: "Hotel lodging", sentences: [["Hotels cost 500 yuan a night.", "hotel_cap"]] }],
        {
          approval: "archived",
        },
      );
      await w.doc(
        "Weekly report",
        [{ heading: "Progress this week", sentences: ["The hotel booking system went live."] }],
        { level: "search_only" },
      );

      const report = await w.topics.recluster(TENANT);
      expect(report.placed).toEqual({ governed: 12, reference: 1, search_only: 0 });
      expect(report.unfiled).toBe(0);
      const hotel = (await w.placement("Hotels in tier-1 cities cost no more than 600 yuan a night."))?.taxonomy_key;
      expect(hotel).toBeDefined();
      expect((await w.placement("The meeting set hotels at 650 yuan a night."))?.taxonomy_key).toBe(hotel);
      expect(await w.placement("The next meeting is in October.")).toBeUndefined();
      expect(await w.placement("Hotels cost 500 yuan a night.")).toBeUndefined();
      expect(await w.records.count(SECTIONS, { tenant_id: TENANT })).toBe(4);

      // A later reference statement of the slot is placed at once.
      await w.doc(
        "October meeting minutes",
        [{ heading: "Agenda", sentences: [["Hotels are raised to 700 yuan a night.", "hotel_cap"]] }],
        {
          level: "reference",
        },
      );
      expect((await w.placement("Hotels are raised to 700 yuan a night."))?.taxonomy_key).toBe(hotel);
    },
  );

  test.skipIf(skip)(
    "confirmed topics and placements stay; topics left without statements retire",
    async ({ world: w }) => {
      await guides(w);
      await w.topics.recluster(TENANT);
      const nodes = await w.store.topics(TENANT, SPACE);
      const [hotel, leave, pay] = ["Hotel lodging", "Annual leave", "Expense payment"].map((t) =>
        nodes.find((n) => n.title === t),
      ) as [TaxonomyNode, TaxonomyNode, TaxonomyNode];
      // An owner renames and confirms the leave topic, and files one payment statement under hotels.
      const moved = about("Expense payment", 1)[0] as string;
      const filed = new Sample().placement(await w.claim(moved), hotel.key, {
        placed_by: "member",
        member_id: "mem_01JC000000000000000000OWNER",
        confirmed: true,
      });
      await w.store.transaction(async (tx) => {
        await tx.putTopics([{ ...leave, status: "confirmed", title: "Leave" }]);
        await tx.place([filed]);
      });

      // Every leave and payment section goes away.
      for (const [i, name] of ["Guide 1", "Guide 2", "Guide 3"].entries()) {
        await w.doc(name, [{ heading: "Hotel lodging", sentences: about("Hotel lodging", 3, 3 * i) }]);
      }
      const report = await w.topics.recluster(TENANT);
      const after = new Map((await w.store.topics(TENANT, SPACE)).map((n) => [n.key, n]));
      expect(after.get(leave.key)).toMatchObject({ status: "confirmed", title: "Leave", statement_count: 0 });
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
      await w.doc("Payroll guide", [{ heading: "Payroll", sentences: about("Payroll", 3) }], {
        sensitivity: "confidential",
      });
      await w.doc("Payroll FAQ", [{ heading: "Payroll", sentences: about("Payroll", 3, 3) }]);
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
