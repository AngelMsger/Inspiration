import { newEvent } from "@inspiration/contracts";
import { InMemoryBus } from "@inspiration/eventbus";
import { describe, expect } from "vitest";
import { COMPONENT } from "../src/index.ts";
import { BACKENDS, inboxTest, LI, SPACE, TENANT, WANG } from "./fixtures.ts";

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  describe.skipIf(skip)("the inbox", () => {
    const test = inboxTest(backend);

    test("a request becomes a todo on its topic owner's card, and a later one with its key replaces it", async ({
      world,
    }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      const { claims } = await world.document(
        ["一线城市住宿限额为每晚 650 元。", "一线城市住宿限额为每晚 600 元。"],
        "t-hotel",
      );
      const units = claims.map((c) => c.id);
      await world.request({ unit_ids: units, dedupe_key: "governance:conflict:hotel", slot_key: "hotel" });
      const [card] = await world.inbox.cards(TENANT);
      expect(card).toMatchObject({
        batch_key: `card:${LI}:t-hotel:2026-W43`,
        kind: "review",
        assignee_id: LI,
        taxonomy_key: "t-hotel",
        week: "2026-W43",
      });
      const todo = card?.todos[0];
      expect(todo).toMatchObject({ kind: "conflict", priority: "normal", status: "open", slot_key: "hotel" });

      // The same slot again: the todo says what the new request says, and stays where it is.
      const again = newEvent(
        "todo.requested",
        {
          kind: "conflict",
          space_id: SPACE,
          title: "hotel_cap_per_night (一线城市): 650 CNY/night or 700 CNY/night",
          priority: "high",
          unit_ids: [units[0] as string],
          dedupe_key: "governance:conflict:hotel",
        },
        { tenantId: TENANT, producer: "governance" },
      );
      await world.deliver(again);
      await world.deliver(again);
      const items = await world.inbox.items(TENANT);
      expect(items).toHaveLength(1);
      expect(items[0]?.todo).toMatchObject({
        id: todo?.id,
        title: "hotel_cap_per_night (一线城市): 650 CNY/night or 700 CNY/night",
        priority: "high",
        unit_ids: [units[0]],
        batch_key: `card:${LI}:t-hotel:2026-W43`,
      });
      expect(items[0]?.todo.slot_key).toBeUndefined();
      expect(await world.created()).toEqual([
        {
          todo_id: todo?.id,
          kind: "conflict",
          space_id: SPACE,
          priority: "normal",
          assignee_id: LI,
          batch_key: `card:${LI}:t-hotel:2026-W43`,
        },
      ]);

      // Once resolved, the key opens a new todo.
      await world.inbox.resolve(TENANT, todo?.id as string, { by: LI, with: "keep_650" });
      await world.request({ unit_ids: units, dedupe_key: "governance:conflict:hotel" });
      expect((await world.inbox.items(TENANT)).map((i) => i.todo.status).sort()).toEqual(["done", "open"]);
    });

    test("a withdrawn request dismisses its open todo, and opens nothing when there is none", async ({ world }) => {
      await world.topics({ key: "t-hotel", owner_id: LI });
      const { claims } = await world.document(["一线城市住宿限额为每晚 600 元。", "北京住宿每晚 800 元。"], "t-hotel");
      const units = claims.map((c) => c.id);
      const note = {
        kind: "note" as const,
        priority: "low" as const,
        unit_ids: units,
        dedupe_key: "governance:note:hotel:800",
      };
      await world.request(note);
      await world.request({ ...note, withdrawn: true });
      expect((await world.inbox.items(TENANT)).map((i) => [i.todo.status, i.todo.resolved_with])).toEqual([
        ["dismissed", "withdrawn"],
      ]);
      expect(await world.inbox.cards(TENANT)).toEqual([]);

      await world.request({ ...note, withdrawn: true });
      expect(await world.inbox.items(TENANT)).toHaveLength(1);
      // Said again later, it is a new note.
      await world.request(note);
      expect((await world.inbox.items(TENANT)).map((i) => i.todo.status).sort()).toEqual(["dismissed", "open"]);
      expect(await world.created()).toHaveLength(2);
    });

    test("first reviews go to a campaign, unowned topics to the steward, copy reviews ride on their conflict's card", async ({
      world,
    }) => {
      await world.topics({ key: "t-hotel", owner_id: LI }, { key: "t-leave", owner_id: WANG }, { key: "t-rooms" });
      const policy = await world.document(["一线城市住宿限额为每晚 600 元。"], "t-hotel");
      const leave = await world.document(["年休假为 5 天。"], "t-leave");
      const rooms = await world.document(["会议室需提前一天预约。"], "t-rooms");
      const loose = await world.document(["办公区禁止吸烟。"]);

      await world.review({ unit_ids: [policy.version.id], backlog: true });
      await world.review({ unit_ids: [rooms.version.id] });
      await world.review({ unit_ids: [loose.version.id] });
      // A source update opens a conflict on the hotel cap and leaves a copy behind.
      await world.request({ unit_ids: policy.claims.map((c) => c.id) }, "evt_01JC00000000000000000UPDATE");
      await world.review(
        { kind: "evidence_changed", unit_ids: [leave.version.id], cause_ids: [policy.version.id] },
        "evt_01JC00000000000000000UPDATE",
      );

      const cards = await world.inbox.cards(TENANT);
      expect(cards.map((c) => [c.batch_key, c.assignee_id ?? null, c.todos.map((t) => t.kind)])).toEqual([
        [`campaign:${SPACE}:t-hotel`, null, ["review_due"]],
        [`card:${LI}:t-hotel:2026-W43`, LI, ["conflict", "stale"]],
        [`steward:${SPACE}:t-rooms:2026-W43`, null, ["review_due"]],
        [`steward:${SPACE}:unfiled:2026-W43`, null, ["review_due"]],
      ]);
      expect(cards[0]?.todos[0]).toMatchObject({ priority: "low", taxonomy_key: "t-hotel" });
    });

    test("a copy review rides on its conflict's card whichever of the two comes first", async ({ world }) => {
      await world.topics(
        { key: "t-hotel", owner_id: LI },
        { key: "t-leave", owner_id: WANG },
        { key: "t-meals", owner_id: WANG },
        { key: "t-rooms", owner_id: LI },
      );
      const hotel = await world.document(["The first-tier hotel cap is 600 a night."], "t-hotel");
      const leave = await world.document(["Annual leave is 5 days."], "t-leave");
      const meals = await world.document(["Meals are capped at 100 a day."], "t-meals");
      const rooms = await world.document(["Meeting rooms are booked a day ahead."], "t-rooms");
      const copy = (of: typeof hotel, cause: typeof hotel) => ({
        kind: "evidence_changed" as const,
        unit_ids: [of.version.id],
        cause_ids: [cause.version.id],
      });

      // Queued together, the consumer takes the review first: it reads review.due before todo.requested.
      const bus = new InMemoryBus();
      for (const [type, handler] of Object.entries(world.inbox.handlers())) bus.subscribe(type, COMPONENT, handler);
      await bus.publish(
        world.requestEvent({ unit_ids: hotel.claims.map((c) => c.id) }, "evt_01JC0000000000000000UPDATE1"),
        world.reviewEvent(copy(leave, hotel), "evt_01JC0000000000000000UPDATE1"),
      );
      await bus.drain();
      expect((await world.created()).map((t) => t.kind)).toEqual(["stale", "conflict"]);
      // The other way round.
      await world.request({ unit_ids: meals.claims.map((c) => c.id) }, "evt_01JC0000000000000000UPDATE2");
      await world.review(copy(rooms, meals), "evt_01JC0000000000000000UPDATE2");

      const cards = await world.inbox.cards(TENANT);
      expect(cards.map((c) => [c.batch_key, c.todos.map((t) => t.kind)])).toEqual([
        [`card:${LI}:t-hotel:2026-W43`, ["conflict", "stale"]],
        [`card:${WANG}:t-meals:2026-W43`, ["conflict", "stale"]],
      ]);
      expect(await world.inbox.reroute(TENANT)).toEqual({ moved: 0 });
    });

    test("a copy review whose conflict closed is routed on its own", async ({ world }) => {
      await world.topics({ key: "t-hotel", owner_id: LI }, { key: "t-leave", owner_id: WANG });
      const hotel = await world.document(["The first-tier hotel cap is 600 a night."], "t-hotel");
      const leave = await world.document(["Annual leave is 5 days."], "t-leave");
      const conflict = { unit_ids: hotel.claims.map((c) => c.id) };
      await world.request(conflict, "evt_01JC00000000000000000UPDATE");
      await world.review(
        { kind: "evidence_changed", unit_ids: [leave.version.id], cause_ids: [hotel.version.id] },
        "evt_01JC00000000000000000UPDATE",
      );
      await world.request({ ...conflict, withdrawn: true });
      expect((await world.inbox.cards(TENANT)).map((c) => c.batch_key)).toEqual([`card:${LI}:t-hotel:2026-W43`]);

      // The hotel topic changes hands; the review goes to the owner of its own topic.
      await world.topics({ key: "t-hotel", owner_id: WANG });
      expect(await world.inbox.reroute(TENANT)).toEqual({ moved: 1 });
      expect((await world.inbox.cards(TENANT)).map((c) => [c.batch_key, c.todos.map((t) => t.kind)])).toEqual([
        [`card:${WANG}:t-leave:2026-W43`, ["stale"]],
      ]);
      expect((await world.inbox.items(TENANT, { open: true }))[0]?.with_todo).toBeUndefined();
      expect(await world.inbox.reroute(TENANT)).toEqual({ moved: 0 });
    });

    test("notes sit outside the budget, on one card a week, and one action acknowledges them", async ({ world }) => {
      await world.topics({ key: "t-hotel", owner_id: LI });
      const { version, claims } = await world.document(
        ["一线城市住宿限额为每晚 600 元。", "北京住宿每晚 800 元。"],
        "t-hotel",
      );
      const units = claims.map((c) => c.id);
      for (let i = 0; i < 3; i++) {
        await world.request({
          kind: "note",
          priority: "low",
          unit_ids: units,
          dedupe_key: `governance:note:hotel:${i}`,
        });
      }
      await world.review({ unit_ids: [version.id] });
      const cards = await world.inbox.cards(TENANT, { assignee: LI, week: "2026-W43" });
      expect(cards.map((c) => [c.batch_key, c.kind, c.todos.length])).toEqual([
        [`card:${LI}:t-hotel:2026-W43`, "review", 1],
        [`notes:${LI}:2026-W43`, "notes", 3],
      ]);
      const notes = cards[1]?.todos.map((t) => t.id) as string[];
      const done = await world.inbox.acknowledge(TENANT, notes, LI);
      expect(done.map((t) => [t.status, t.resolved_with, t.resolved_by])).toEqual(
        Array(3).fill(["done", "acknowledged", LI]),
      );
      await expect(world.inbox.acknowledge(TENANT, [cards[0]?.todos[0]?.id as string], LI)).rejects.toThrow(RangeError);
      await expect(world.inbox.acknowledge(TENANT, ["todo_01JC0000000000000UNKNOWN"], LI)).rejects.toThrow(RangeError);
      expect(await world.inbox.cards(TENANT, { assignee: LI })).toHaveLength(1);
    });

    test("todos move to the owner's next open week when routing changes", async ({ world }) => {
      await world.topics({ key: "t-hotel" });
      const { claims } = await world.document(["一线城市住宿限额为每晚 600 元。"], "t-hotel");
      await world.request({ unit_ids: [claims[0]?.id as string] });
      expect((await world.inbox.cards(TENANT))[0]?.batch_key).toBe(`steward:${SPACE}:t-hotel:2026-W43`);

      // The business layer names an owner, and the open todo goes to the owner's card.
      await world.topics({ key: "t-hotel", owner_id: WANG });
      world.setToday("2026-10-27");
      expect(await world.inbox.reroute(TENANT)).toEqual({ moved: 1 });
      expect(await world.inbox.cards(TENANT)).toMatchObject([
        { batch_key: `card:${WANG}:t-hotel:2026-W43`, assignee_id: WANG, week: "2026-W43" },
      ]);
      expect(await world.inbox.reroute(TENANT)).toEqual({ moved: 0 });
    });
  });

  describe.skipIf(skip)("the weekly budget", () => {
    const test = inboxTest(backend, { budget: 2, cardSize: 2, horizon: 2 });

    test("an owner gets at most `budget` cards a week, of at most `cardSize` todos; urgent ones stay in their week", async ({
      world,
    }) => {
      await world.topics(
        { key: "t-hotel", owner_id: LI },
        { key: "t-leave", owner_id: LI },
        { key: "t-rooms", owner_id: LI },
      );
      const hotel = await Promise.all([1, 2, 3].map((n) => world.document([`住宿规定第 ${n} 条。`], "t-hotel")));
      const leave = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => world.document([`休假规定第 ${n} 条。`], "t-leave")),
      );
      const rooms = await world.document(["会议室需提前一天预约。"], "t-rooms");

      for (const d of hotel) await world.review({ unit_ids: [d.version.id] });
      for (const d of leave) await world.review({ unit_ids: [d.version.id] });
      await world.request({ unit_ids: [rooms.claims[0]?.id as string], priority: "high" });

      const cards = await world.inbox.cards(TENANT, { assignee: LI });
      expect(cards.map((c) => [c.week, c.batch_key.split(":").slice(2).join(":"), c.todos.length])).toEqual([
        // Three hotel reviews fill a card and start a second: the week's two cards.
        ["2026-W43", "t-hotel:2026-W43", 2],
        ["2026-W43", "t-hotel:2026-W43:2", 1],
        // The ninth leave review finds no room within two weeks: its due week, over the budget.
        ["2026-W43", "t-leave:2026-W43", 1],
        // The high conflict stays in its week, over the budget too.
        ["2026-W43", "t-rooms:2026-W43", 1],
        // The other leave reviews move on, two cards a week.
        ["2026-W44", "t-leave:2026-W44", 2],
        ["2026-W44", "t-leave:2026-W44:2", 2],
        ["2026-W45", "t-leave:2026-W45", 2],
        ["2026-W45", "t-leave:2026-W45:2", 2],
      ]);
      const items = await world.inbox.items(TENANT);
      expect(items.filter((i) => i.todo.week !== i.due_week)).toHaveLength(8);
    });

    test("campaign and steward cards hold at most `cardSize` todos too", async ({ world }) => {
      await world.topics({ key: "t-hotel", owner_id: LI }, { key: "t-rooms" });
      for (const n of [1, 2, 3]) {
        const hotel = await world.document([`住宿规定第 ${n} 条。`], "t-hotel");
        await world.review({ unit_ids: [hotel.version.id], backlog: true });
        const rooms = await world.document([`会议室规定第 ${n} 条。`], "t-rooms");
        await world.review({ unit_ids: [rooms.version.id] });
      }
      const cards = await world.inbox.cards(TENANT);
      expect(cards.map((c) => [c.batch_key, c.todos.length])).toEqual([
        [`campaign:${SPACE}:t-hotel`, 2],
        [`campaign:${SPACE}:t-hotel:2`, 1],
        [`steward:${SPACE}:t-rooms:2026-W43`, 2],
        [`steward:${SPACE}:t-rooms:2026-W43:2`, 1],
      ]);
    });
  });
});
