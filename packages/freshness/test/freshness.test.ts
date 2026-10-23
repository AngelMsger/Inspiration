import { newEvent } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { BACKENDS, freshnessTest, TENANT } from "./fixtures.ts";

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = freshnessTest(backend);

  describe.skipIf(skip)("freshness", () => {
    test("a document is due when the shortest interval of its classes has passed since it changed", async ({
      world,
    }) => {
      world.setToday("2026-03-01");
      const policy = await world.put({ path: "差旅费管理办法.md", modified: "2026-01-10" }, [
        { text: "一线城市住宿限额为每晚 600 元。", knowledge_class: "policy" },
        { text: "协议酒店价格每季度更新一次。", knowledge_class: "pricing" },
        { text: "预计 2026 年 6 月 1 日上线新的差旅系统。", on: "2026-06-01" },
      ]);
      // Records of a day and general knowledge are never due by age.
      await world.put({ path: "财务部例会纪要.md", modified: "2026-01-12", date: "2026-01-12" }, [
        { text: "会议确定住宿限额维持不变。", knowledge_class: "policy" },
      ]);
      await world.put({ path: "项目方案.md", modified: "2025-01-01" }, [{ text: "检索模块 P95 延迟 420 毫秒。" }]);

      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.document.split(":")[1], d.kind, d.day])).toEqual([
        ["差旅费管理办法.md", "ttl", "2026-04-10"],
        ["差旅费管理办法.md", "assumption", "2026-06-01"],
      ]);
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      const [early] = await world.freshness.staleness(TENANT, [policy.version.id]);
      expect(early).toMatchObject({
        state: "fresh",
        age_component: 0.556,
        ttl: "P90D",
        review_due: "2026-04-10T00:00:00Z",
      });

      world.setToday("2026-04-10");
      expect(await world.freshness.tick(TENANT)).toEqual([
        {
          unit_ids: [policy.version.id],
          kind: "ttl",
          due_at: "2026-04-10T00:00:00Z",
          space_id: policy.version.space_id,
          reason:
            "差旅费管理办法 last changed on 2026-01-10; documents with pricing claims are reviewed every 90 days.",
          dedupe_key: `freshness:ttl:${policy.version.source_id}:差旅费管理办法.md`,
        },
      ]);
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      const [due] = await world.freshness.staleness(TENANT, [policy.version.id]);
      expect(due).toMatchObject({ state: "stale", score: 1 });

      // The same version's claims again schedule nothing new; a new version restarts the clock.
      await world.deliver(
        newEvent(
          "claims.updated",
          { origin: "extracted", added: [], updated: [], superseded: [], source_version_id: policy.version.id },
          { tenantId: TENANT, producer: "extraction" },
        ),
      );
      expect((await world.freshness.upcoming(TENANT)).map((d) => d.kind)).toEqual(["assumption"]);
      await world.put(
        { path: "差旅费管理办法.md", modified: "2026-04-10" },
        [{ text: "一线城市住宿限额为每晚 650 元。", knowledge_class: "policy" }],
        { previous: policy },
      );
      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.kind, d.day])).toEqual([["ttl", "2027-04-10"]]);
    });

    test("a plan's day brings an assumption review; a day already past, or a record's plan, does not", async ({
      world,
    }) => {
      const report = await world.put({ path: "星火项目方案.md", modified: "2026-10-19" }, [
        { text: "预计 11 月 20 日完成灰度发布。", on: "2026-11-20" },
        { text: "预计 12 月 1 日完成全量上线。", on: "2026-12-01" },
        { text: "预计 9 月 1 日完成接口联调。", on: "2026-09-01" },
        { text: "本周处理工单 120 张。" },
      ]);
      // A weekly report is a record of its week: the next report says what became of its plans.
      await world.put({ path: "星火项目周报.md", modified: "2026-10-23", date: "2026-10-23" }, [
        { text: "预计 11 月 25 日完成验收。", on: "2026-11-25" },
      ]);
      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.kind, d.day])).toEqual([
        ["assumption", "2026-11-20"],
        ["assumption", "2026-12-01"],
      ]);

      world.setToday("2026-11-25");
      const [review] = await world.freshness.tick(TENANT);
      const [rollout, , , tickets] = report.claims;
      expect(review).toMatchObject({
        kind: "assumption",
        unit_ids: [rollout?.id],
        reason: "星火项目方案 planned 1 thing for 2026-11-20; check whether it happened.",
      });
      const scores = await world.freshness.staleness(TENANT, [rollout?.id as string, tickets?.id as string]);
      expect(scores.map((s) => s.state)).toEqual(["at_risk", "fresh"]);

      // A plan withdrawn before its day asks nothing.
      await world.put({ path: "星火项目方案.md", modified: "2026-11-26" }, [{ text: "本周处理工单 120 张。" }], {
        previous: report,
      });
      world.setToday("2026-12-02");
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      expect(await world.reviews()).toHaveLength(1);
    });

    test("an edit leaves its copies behind, but not the archive or a more authoritative original", async ({
      world,
    }) => {
      const policy = await world.put({ path: "制度库/差旅费管理办法.md", authority: 0.9, modified: "2026-01-01" }, [
        { text: "一线城市住宿限额为每晚 600 元。", knowledge_class: "policy" },
      ]);
      const archive = await world.put(
        {
          path: "归档/差旅费管理办法（2023 版）.md",
          authority: 0.3,
          approval_state: "archived",
          modified: "2023-01-01",
        },
        [{ text: "一线城市住宿限额为每晚 500 元。", knowledge_class: "policy" }],
        { duplicates: [{ of: policy, similarity: 0.9 }] },
      );
      const copy = await world.put(
        { path: "共享/转发-差旅费管理办法.md", authority: 0.4, modified: "2026-01-05" },
        [{ text: "一线城市住宿限额为每晚 600 元。", knowledge_class: "policy" }],
        {
          duplicates: [
            { of: policy, similarity: 1 },
            { of: archive, similarity: 0.9 },
          ],
        },
      );
      expect([...policy.reviews, ...archive.reviews, ...copy.reviews]).toEqual([]);

      const edited = await world.put(
        { path: "制度库/差旅费管理办法.md", authority: 0.9, modified: "2026-10-23" },
        [{ text: "一线城市住宿限额为每晚 650 元。", knowledge_class: "policy" }],
        {
          previous: policy,
          duplicates: [
            { of: archive, similarity: 0.8 },
            { of: copy, similarity: 0.9 },
          ],
        },
      );
      expect(edited.reviews).toEqual([
        {
          unit_ids: [copy.version.id],
          kind: "evidence_changed",
          due_at: "2026-10-23T09:00:00.000Z",
          space_id: copy.version.space_id,
          reason:
            "共享/转发-差旅费管理办法 repeats 制度库/差旅费管理办法, which changed on 2026-10-23; it has not changed since.",
          cause_ids: [edited.version.id],
          dedupe_key: `freshness:evidence_changed:${copy.version.source_id}:共享/转发-差旅费管理办法.md`,
        },
      ]);
      const [behind] = await world.freshness.staleness(TENANT, [copy.version.id]);
      expect(behind).toMatchObject({ state: "at_risk", upstream_component: 1 });

      // The copy catches up: it is fresh again, and the policy is not asked about the copy's edit.
      const caught = await world.put(
        { path: "共享/转发-差旅费管理办法.md", authority: 0.4, modified: "2026-10-24" },
        [{ text: "一线城市住宿限额为每晚 650 元。", knowledge_class: "policy" }],
        { previous: copy, duplicates: [{ of: edited, similarity: 1 }] },
      );
      expect(caught.reviews).toEqual([]);
      const [fresh] = await world.freshness.staleness(TENANT, [caught.version.id]);
      expect(fresh?.state).toBe("fresh");
      expect(await world.reviews()).toHaveLength(1);
    });

    test("a review already due when its document arrives is marked as backlog", async ({ world }) => {
      world.setToday("2026-03-01");
      await world.put({ path: "报销常见问题.md", modified: "2025-01-01" }, [
        { text: "差旅费应在返回后 30 天内报销。", knowledge_class: "policy" },
      ]);
      await world.put({ path: "差旅费管理办法.md", modified: "2026-01-10" }, [
        { text: "一线城市住宿限额为每晚 600 元。", knowledge_class: "policy" },
      ]);
      expect((await world.freshness.tick(TENANT)).map((r) => [r.reason, r.backlog])).toEqual([
        ["报销常见问题 last changed on 2025-01-01; documents with policy claims are reviewed every 365 days.", true],
      ]);
      world.setToday("2027-01-10");
      expect((await world.freshness.tick(TENANT)).map((r) => r.backlog)).toEqual([undefined]);
    });

    test("a deleted document is forgotten, and a redelivered event changes nothing", async ({ world }) => {
      const guide = await world.put({ path: "办事指南.md", modified: "2026-05-01" }, [
        { text: "出差结束后 30 日内须提交报销。", knowledge_class: "process" },
      ]);
      const change = newEvent(
        "blocks.changed",
        {
          source_id: guide.version.source_id,
          source_version_id: guide.version.id,
          added_block_ids: [],
          changed_block_ids: [],
          removed_block_ids: [],
          unchanged_block_count: 0,
          added_span_ids: [],
          removed_span_ids: [],
        },
        { tenantId: TENANT, producer: "normalization" },
      );
      await world.deliver(change);
      await world.deliver(change);
      expect((await world.freshness.upcoming(TENANT)).map((d) => d.day)).toEqual(["2026-10-28"]);

      world.setToday("2026-10-24");
      const gone = await world.put({ path: "办事指南.md", modified: "2026-10-24" }, [], { previous: guide });
      await world.deliver(
        newEvent(
          "blocks.changed",
          {
            source_id: gone.version.source_id,
            source_version_id: gone.version.id,
            previous_version_id: guide.version.id,
            added_block_ids: [],
            changed_block_ids: [],
            removed_block_ids: [],
            unchanged_block_count: 0,
            added_span_ids: [],
            removed_span_ids: [],
            deleted: true,
          },
          { tenantId: TENANT, producer: "normalization" },
        ),
      );
      expect(await world.freshness.documents(TENANT)).toEqual([]);
      expect(await world.freshness.upcoming(TENANT)).toEqual([]);
    });
  });
});
