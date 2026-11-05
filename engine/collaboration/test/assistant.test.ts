// Decide for me: the assistant decides a member's todos from the requester's advice and the
// todo's kind, leaves the rest with why, undoes on request, and keeps the standing delegation.

import type { Principal, TodoAdvice, TodoResolution } from "@inspiration/contracts";
import { loadLanguages } from "@inspiration/kernel";
import { describe, expect } from "vitest";
import { BACKENDS, inboxTest, LI, TENANT, WANG, type World } from "./fixtures.ts";

const PACKS = new Map(loadLanguages(new URL("../languages/", import.meta.url)).map((p) => [p.tag, p]));
const EN = PACKS.get("en") as NonNullable<ReturnType<typeof PACKS.get>>;
const reason = (key: string) => EN.section("reasons").text(key);
const leftFor = (key: string) => EN.section("left").text(key);

const member = (id: string, locale = "en"): Principal => ({ id, kind: "member", tenant_id: TENANT, locale });
const ME = member(LI);

const SURE: TodoAdvice = { with: "choose:650 CNY/night", sure: true, basis: "changed" };
const UNSURE: TodoAdvice = { with: "choose:650 CNY/night", sure: false, basis: "disagreement" };

/** A hotel cap conflict, owned by Li, with governance's advice: one per slot. */
async function conflict(world: World, slot: string, suggestion?: TodoAdvice): Promise<string> {
  const { claims } = await world.document(
    [`The ${slot} in tier-1 cities is 650 yuan.`, `The ${slot} in tier-1 cities is 600 yuan.`],
    "t-hotel",
  );
  const resolutions: TodoResolution[] = ["650 CNY/night", "600 CNY/night"].map((value, i) => ({
    key: `choose:${value}`,
    label: `${i ? "Choose" : "Keep"} ${value}`,
    effect: { slot_key: slot, value },
  }));
  await world.request({
    unit_ids: claims.map((c) => c.id),
    dedupe_key: `governance:conflict:${slot}`,
    slot_key: slot,
    resolutions,
    ...(suggestion && { suggestion }),
  });
  const [item] = (await world.inbox.items(TENANT)).filter(
    (i) => i.dedupe_key === `governance:conflict:${slot}` && i.todo.status === "open",
  );
  return item?.todo.id as string;
}

const statusOf = async (world: World, id: string) => (await world.inbox.todo(TENANT, id))?.status;

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  describe.skipIf(skip)("the assistant", () => {
    const test = inboxTest(backend);

    test("decides what it is sure of on a card and leaves the rest with why", async ({ world }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      const sure = await conflict(world, "hotel", SURE);
      const unsure = await conflict(world, "meals", UNSURE);
      const { version } = await world.document(["Hotels are booked through the travel desk."], "t-hotel");
      await world.review({ unit_ids: [version.id] });
      const [card] = await world.inbox.cards(TENANT, { assignee: LI });
      expect(card?.todos).toHaveLength(3);
      const review = card?.todos.find((t) => t.kind === "review_due")?.id;

      const decided = await world.assistant.decide(ME, { batch_key: card?.batch_key as string });
      expect(decided.decisions.map((d) => [d.todo.id, d.with, d.label, d.reason, d.via, d.decided_by])).toEqual([
        [sure, "choose:650 CNY/night", "Keep 650 CNY/night", reason("changed"), "assistant_batch", LI],
        [review, "reviewed", EN.section("labels").text("reviewed"), reason("unchanged"), "assistant_batch", LI],
      ]);
      expect(decided.left).toEqual([
        {
          todo_id: unsure,
          reason: leftFor("unsure"),
          suggestion: { with: "choose:650 CNY/night", reason: reason("disagreement") },
        },
      ]);
      // Closed as the member would close them: the requester applies the choice.
      expect((await world.resolved()).map((r) => [r.todo_id, r.resolved_by, r.resolved_with])).toEqual([
        [sure, LI, "choose:650 CNY/night"],
        [review, LI, "reviewed"],
      ]);
      // What it left stays on the card, marked, with the suggestion selected.
      expect((await world.inbox.cards(TENANT, { assignee: LI }))[0]?.todos.map((t) => t.id)).toEqual([unsure]);
      expect((await world.assistant.marks(ME, [unsure])).get(unsure)).toEqual({
        suggestion: { with: "choose:650 CNY/night", reason: reason("disagreement") },
        left: { reason: leftFor("unsure") },
      });

      // Asked again, it leaves the same todo again and decides nothing twice.
      expect(await world.assistant.decide(ME, { batch_key: card?.batch_key as string })).toMatchObject({
        decisions: [],
        left: [{ todo_id: unsure }],
      });
      // Another member's card, or a todo of theirs, is not the member's to decide.
      expect(await world.assistant.decide(member(WANG), { batch_key: card?.batch_key as string })).toEqual({
        decisions: [],
        left: [],
      });
      await expect(world.assistant.decide(member(WANG), { todo_ids: [unsure] })).rejects.toThrow(RangeError);
    });

    test("acknowledges notes, waits on a copy review's conflict and never decides other kinds", async ({ world }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      const { claims } = await world.document(["The hotel cap is 650 yuan.", "The guide says 600 yuan."], "t-hotel");
      await world.request({
        kind: "note",
        unit_ids: claims.map((c) => c.id),
        dedupe_key: "governance:note:hotel:600",
      });
      const { version: copy } = await world.document(["The hotel cap is 600 yuan."], "t-hotel");
      await world.request({ unit_ids: claims.map((c) => c.id), dedupe_key: "governance:conflict:hotel" }, "evt-update");
      await world.review(
        { kind: "evidence_changed", unit_ids: [copy.id], dedupe_key: `freshness:evidence_changed:${copy.id}` },
        "evt-update",
      );
      await world.review({ kind: "assumption", unit_ids: [copy.id], dedupe_key: `freshness:assumption:${copy.id}` });
      const todos = await world.inbox.items(TENANT, { open: true });
      const id = (kind: string) => todos.find((i) => i.todo.kind === kind)?.todo.id as string;

      const decided = await world.assistant.decide(ME, {
        todo_ids: [id("note"), id("stale"), id("assumption_drift"), id("conflict")],
      });
      expect(decided.decisions.map((d) => [d.todo.kind, d.with, d.reason])).toEqual([
        ["note", "acknowledged", reason("note")],
      ]);
      expect(Object.fromEntries(decided.left.map((l) => [l.todo_id, l.reason]))).toEqual({
        [id("stale")]: leftFor("with_conflict"),
        [id("assumption_drift")]: leftFor("never"),
        // Governance gave no advice on this one.
        [id("conflict")]: leftFor("no_advice"),
      });
      expect(await statusOf(world, id("note"))).toBe("done");
    });

    test("never outvotes a person who chose otherwise on the same question", async ({ world }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      const first = await conflict(world, "hotel", SURE);
      await world.inbox.resolve(TENANT, first, { by: WANG, with: "choose:600 CNY/night" });
      const again = await conflict(world, "hotel", SURE);
      expect(again).not.toBe(first);
      const decided = await world.assistant.decide(ME, { todo_ids: [again] });
      expect(decided).toEqual({
        decisions: [],
        left: [
          {
            todo_id: again,
            reason: leftFor("person_decided"),
            suggestion: { with: SURE.with, reason: reason("changed") },
          },
        ],
      });
    });

    test("undo reopens the todo, tells its requester, and is refused the second time", async ({ world }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      const todo = await conflict(world, "hotel", SURE);
      const {
        decisions: [decision],
      } = await world.assistant.decide(ME, { todo_ids: [todo] });
      expect(decision).toMatchObject({ via: "assistant_once", todo: { id: todo, status: "done" } });
      const id = decision?.id as string;

      expect(await world.assistant.undo(member(WANG), id)).toEqual({});
      const undone = await world.assistant.undo(ME, id);
      expect(undone.todo).toMatchObject({ id: todo, status: "open" });
      expect(undone.todo?.resolved_at).toBeUndefined();
      expect((await world.published("todo.reopened")).map((e) => e.data)).toEqual([
        {
          todo_id: todo,
          kind: "conflict",
          space_id: undone.todo?.space_id,
          dedupe_key: "governance:conflict:hotel",
          slot_key: "hotel",
          created_by: "governance",
          decision_id: id,
          undid: "choose:650 CNY/night",
          reopened_by: LI,
        },
      ]);
      expect((await world.assistant.marks(ME, [todo])).get(todo)?.left).toEqual({ reason: leftFor("undone") });
      expect(await world.assistant.undo(ME, id)).toEqual({ refused: `decision ${id} was undone already` });

      // The week's view keeps the undone decision and counts it.
      const week = await world.assistant.week(ME);
      expect(week).toMatchObject({ week: "2026-W43", left: 0, undone: 1 });
      expect(week.decisions.map((d) => [d.id, d.undone_at !== undefined])).toEqual([[id, true]]);
    });

    test("a standing delegation decides new todos as they arrive, and pauses after two undos", async ({ world }) => {
      await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
      expect(await world.assistant.delegation(TENANT, LI)).toEqual({
        state: "unset",
        kinds: ["review_due", "stale", "conflict", "note"],
      });
      // Unset: nothing is decided as it arrives.
      const before = await conflict(world, "parking", SURE);
      await world.arrive();
      expect(await statusOf(world, before)).toBe("open");

      expect(await world.assistant.setDelegation(TENANT, LI, "on")).toMatchObject({ state: "on" });
      const todos = [await conflict(world, "hotel", SURE), await conflict(world, "meals", SURE)];
      const unsure = await conflict(world, "taxi", UNSURE);
      await world.arrive();
      await world.arrive();
      for (const t of todos) expect(await statusOf(world, t)).toBe("done");
      expect(await statusOf(world, unsure)).toBe("open");
      expect((await world.assistant.marks(ME, [unsure])).get(unsure)?.left).toEqual({ reason: leftFor("unsure") });
      // The todo from before the delegation stays the member's.
      expect(await statusOf(world, before)).toBe("open");
      const week = await world.assistant.week(ME);
      expect(week.decisions.map((d) => d.via)).toEqual(["delegation", "delegation"]);
      expect(week.left).toBe(1);

      // Two undos of the last ten conflicts pause it, and it says why.
      for (const d of week.decisions) await world.assistant.undo(ME, d.id);
      expect(await world.assistant.delegation(TENANT, LI)).toMatchObject({ state: "paused", paused_reason: "undone" });
      const after = await conflict(world, "laundry", SURE);
      await world.arrive();
      expect(await statusOf(world, after)).toBe("open");

      expect(await world.assistant.setDelegation(TENANT, LI, "paused")).toMatchObject({
        state: "paused",
        paused_reason: "person",
      });
    });
  });
});

describe("the assistant's language", () => {
  const test = inboxTest("memory");

  test.for([
    ["en", "en"],
    ["zh-CN", "zh"],
    ["ja", "ja"],
    ["fr", "en"],
  ])("writes for %s in the %s pack", async ([locale, tag], { world }) => {
    await world.topics({ key: "a-travel", owner_id: LI }, { key: "t-hotel", parent_key: "a-travel" });
    const todo = await conflict(world, "hotel", SURE);
    const pack = PACKS.get(tag as string);
    const {
      decisions: [decision],
    } = await world.assistant.decide(member(LI, locale), { todo_ids: [todo] });
    expect(decision?.reason).toBe(pack?.section("reasons").text("changed"));
  });
});
