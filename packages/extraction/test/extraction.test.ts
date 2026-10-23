import { type ClaimsUpdated, payloadOf } from "@inspiration/contracts";
import type { FakeProvider } from "@inspiration/model-gateway";
import { describe, expect } from "vitest";
import { BACKENDS, extractionTest, type Para } from "./fixtures.ts";

const HEADING = ["差旅费管理办法", "第三章 住宿"];

const POLICY: Para[] = [
  {
    id: "p1",
    heading: HEADING,
    text: "一线城市住宿限额为每晚 600 元。成都、杭州的住宿标准是每晚 450 元。住宿费凭发票报销。",
  },
  { id: "p2", heading: HEADING, text: "出差结束后 30 日内须提交差旅报销申请。审批通过的报销款于每周三统一支付。" },
  { id: "p3", heading: HEADING, text: "大家辛苦了。有问题吗？" },
];

const claimsUpdated = (events: { type: string }[]) =>
  events
    .filter((e) => e.type === "claims.updated")
    .map((e) => payloadOf(e as never, "claims.updated") as ClaimsUpdated);

describe.each(BACKENDS)("$backend store", ({ backend, skip }) => {
  const test = extractionTest(backend);

  describe.skipIf(skip)("extraction", () => {
    test("a claim is true from the day its passage names, else from the document's effective date", async ({
      world,
    }) => {
      const { result } = await world.version(
        "通知.md",
        [
          {
            id: "p1",
            text: "自 2026 年 10 月 1 日起，一线城市住宿限额调整为每晚 650 元。成都的住宿标准是每晚 450 元。",
          },
        ],
        { effectiveFrom: "2026-01-01" },
      );
      const claims = await world.store.getClaims(result.added);
      expect(Object.fromEntries(claims.map((c) => [c.value?.number, c.valid_time]))).toEqual({
        650: { start: "2026-10-01T00:00:00Z" },
        450: { start: "2026-01-01T00:00:00Z" },
      });
    });

    test("claims cite verbatim quotes and fill slots from the catalogue", async ({ world }) => {
      const { version, result } = await world.version("差旅费管理办法.md", POLICY);
      expect(result).toMatchObject({ windows: 1, failed_windows: 0, rejected: 0, superseded: [], retracted: [] });
      const claims = await world.store.getClaims(result.added);
      const by = new Map(claims.map((c) => [c.statement, c]));
      expect([...by.keys()].sort()).toEqual(
        [
          "一线城市住宿限额为每晚 600 元。",
          "成都、杭州的住宿标准是每晚 450 元。",
          "住宿费凭发票报销。",
          "出差结束后 30 日内须提交差旅报销申请。",
          "审批通过的报销款于每周三统一支付。",
        ].sort(),
      );
      expect(by.get("一线城市住宿限额为每晚 600 元。")).toMatchObject({
        predicate: "hotel_cap_per_night",
        qualifiers: ["一线城市"],
        value: { kind: "money", number: 600, currency: "CNY", normalized: "600 CNY/night" },
        claim_type: "rule",
        knowledge_class: "policy",
        subject_text: "第三章 住宿",
        status: "active",
        origin: "extracted",
        sensitivity: "internal",
        authority: 0.9,
      });
      expect(by.get("成都、杭州的住宿标准是每晚 450 元。")?.qualifiers).toEqual(["新一线城市"]);
      expect(by.get("住宿费凭发票报销。")).toMatchObject({ predicate: "hotel_cap_per_night" });
      expect(by.get("住宿费凭发票报销。")?.value).toBeUndefined();
      expect(by.get("审批通过的报销款于每周三统一支付。")?.value).toEqual({
        kind: "enum",
        text: "每周三",
        normalized: "每周三",
      });
      const evidence = await world.store.evidenceOf(result.added);
      expect(evidence).toHaveLength(5);
      const spans = new Map((await world.store.spansOf(version.id)).map((s) => [s.id, s]));
      for (const e of evidence) {
        const span = spans.get(e.span_id);
        expect(span?.text.slice(e.quote_start, e.quote_end)).toBe(e.quote);
        expect(e.source_version_id).toBe(version.id);
      }
      const [event] = claimsUpdated(await world.events());
      expect(event).toEqual({
        origin: "extracted",
        added: result.added,
        updated: [],
        superseded: [],
        source_version_id: version.id,
      });

      // Doing it again finds the same claims and publishes nothing.
      const again = await world.extraction.extract({
        source_id: version.source_id,
        source_version_id: version.id,
        added_block_ids: (await world.store.blocksOf(version.id)).map((b) => b.id),
        changed_block_ids: [],
        removed_block_ids: [],
        added_span_ids: [],
        removed_span_ids: [],
      });
      expect(again.added).toEqual([]);
      expect(claimsUpdated(await world.events())).toHaveLength(1);
    });

    test("an edit supersedes the claims whose sentences changed and keeps the rest", async ({ world }) => {
      const first = await world.version("差旅费管理办法.md", POLICY);
      const claims = await world.store.getClaims(first.result.added);
      const id = (statement: string) => claims.find((c) => c.statement === statement)?.id;
      const edited: Para[] = [
        {
          ...(POLICY[0] as Para),
          text: "一线城市住宿限额为每晚 650 元。成都、杭州的住宿标准是每晚 450 元。住宿费凭发票报销。",
        },
        { ...(POLICY[1] as Para), text: "出差结束后 30 日内须提交差旅报销申请。" },
        POLICY[2] as Para,
        { id: "p4", heading: HEADING, text: "住宿超标部分由个人承担。" },
      ];
      const { version, change, result } = await world.version("差旅费管理办法.md", edited);
      expect(change.changed_block_ids).toHaveLength(2);
      expect(change.removed_span_ids).toHaveLength(2);

      const added = await world.store.getClaims(result.added);
      expect(added.map((c) => c.statement).sort()).toEqual([
        "一线城市住宿限额为每晚 650 元。",
        "住宿超标部分由个人承担。",
      ]);
      const cap650 = added.find((c) => c.value?.number === 650)?.id;
      expect(result.superseded).toEqual([id("一线城市住宿限额为每晚 600 元。")]);
      expect(result.retracted).toEqual([id("审批通过的报销款于每周三统一支付。")]);

      const [old600, payment] = await world.store.getClaims([
        id("一线城市住宿限额为每晚 600 元。") as string,
        id("审批通过的报销款于每周三统一支付。") as string,
      ]);
      expect(old600).toMatchObject({ status: "superseded", superseded_by: cap650 });
      expect(payment).toMatchObject({ status: "retracted" });
      expect(payment?.superseded_at).toBeDefined();

      const current = await world.store.asOf({ source_version_ids: [first.version.id, version.id] });
      expect(current.map((c) => c.statement).sort()).toEqual(
        [
          "一线城市住宿限额为每晚 650 元。",
          "成都、杭州的住宿标准是每晚 450 元。",
          "住宿费凭发票报销。",
          "出差结束后 30 日内须提交差旅报销申请。",
          "住宿超标部分由个人承担。",
        ].sort(),
      );
      const event = claimsUpdated(await world.events()).at(-1);
      expect(event).toMatchObject({ added: result.added, source_version_id: version.id });
      expect(event?.superseded.sort()).toEqual([...result.superseded, ...result.retracted].sort());
    });

    test("a reworded sentence without a slot is superseded by the most similar one in its block", async ({ world }) => {
      const first = await world.version("会议室.md", [{ id: "p1", text: "会议室单次预订不超过 4 小时，须提前登记。" }]);
      const second = await world.version("会议室.md", [
        { id: "p1", text: "会议室单次预订不超过 3 小时，须提前登记。" },
      ]);
      expect(second.result.superseded).toEqual(first.result.added);
      expect(second.result.retracted).toEqual([]);
    });

    test("table rows become claims that cite their cells", async ({ world }) => {
      const { result } = await world.version("城市住宿标准.csv", [
        { id: "t", kind: "table", text: "", header_rows: 1 },
        { id: "r0", kind: "table_row", table: "t", text: "城市\t等级\t住宿限额（元/晚）" },
        { id: "r1", kind: "table_row", table: "t", text: "北京\t一线城市\t600" },
        { id: "r2", kind: "table_row", table: "t", text: "成都\t新一线城市\t450" },
      ]);
      const claims = await world.store.getClaims(result.added);
      expect(claims.map((c) => [c.statement, c.qualifiers, c.value?.number]).sort()).toEqual([
        ["城市：北京，等级：一线城市，住宿限额（元/晚）：600。", ["一线城市"], 600],
        ["城市：成都，等级：新一线城市，住宿限额（元/晚）：450。", ["新一线城市"], 450],
      ]);
      const evidence = await world.store.evidenceOf(result.added);
      expect(evidence.map((e) => e.quote).sort()).toEqual(["450", "600", "一线城市", "北京", "成都", "新一线城市"]);

      // A new header changes how every row reads: the rows' claims are restated.
      const edited = await world.version("城市住宿标准.csv", [
        { id: "t", kind: "table", text: "", header_rows: 1 },
        { id: "r0", kind: "table_row", table: "t", text: "城市\t等级\t住宿限额（元/晚，含税）" },
        { id: "r1", kind: "table_row", table: "t", text: "北京\t一线城市\t600" },
        { id: "r2", kind: "table_row", table: "t", text: "成都\t新一线城市\t450" },
      ]);
      expect(edited.change.changed_block_ids).toHaveLength(1);
      expect(edited.result.added).toHaveLength(2);
      expect(edited.result.superseded.sort()).toEqual([...result.added].sort());
    });

    test("a deleted document retracts its claims", async ({ world }) => {
      const first = await world.version("差旅费管理办法.md", POLICY);
      const { result } = await world.version("差旅费管理办法.md", [], { deleted: true });
      expect(result.windows).toBe(0);
      expect(result.retracted.sort()).toEqual([...first.result.added].sort());
      expect(await world.store.asOf({ source_version_ids: [first.version.id] })).toEqual([]);
    });

    test("confidential documents are extracted by a model cleared for them", async ({ world }) => {
      await world.version("差旅费管理办法.md", POLICY);
      await world.version("2027 年度预算.md", [{ id: "p1", text: "研发部预算上限为 1200 万元。" }], {
        sensitivity: "confidential",
      });
      expect(world.routed()).toEqual(["internal", "confidential"]);
      const claims = await world.store.asOf({});
      expect(claims.find((c) => c.statement.startsWith("研发部"))?.sensitivity).toBe("confidential");
    });

    test("claims without a verbatim quote are rejected", async ({ world }) => {
      const reply = JSON.stringify({
        claims: [
          { statement: "住宿限额 600 元", claim_type: "rule", evidence: [{ span: "s1", quote: "每晚 600 元。" }] },
          { statement: "编造的规定", claim_type: "rule", evidence: [{ span: "s1", quote: "每晚 999 元" }] },
          { statement: "不存在的段落", claim_type: "rule", evidence: [{ span: "s9", quote: "x" }] },
        ],
      });
      for (const name of ["cloud", "local"])
        world.gateway.provider<FakeProvider>(name).script("extraction.extract_claims", reply);
      const { result } = await world.version("差旅费管理办法.md", [POLICY[0] as Para]);
      expect(result.rejected).toBe(2);
      expect((await world.store.getClaims(result.added)).map((c) => c.statement)).toEqual(["住宿限额 600 元"]);
    });
  });
});
