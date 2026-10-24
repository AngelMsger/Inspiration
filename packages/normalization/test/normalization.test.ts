import { type EventEnvelope, newEvent, type Parser, payloadOf } from "@inspiration/contracts";
import { MemoryRecords } from "@inspiration/eventbus";
import { LocalBlobStore, registry } from "@inspiration/kernel";
import { MemoryStore } from "@inspiration/knowledge-store";
import { describe, expect, test } from "vitest";
import { Normalization } from "../src/index.ts";
import { BACKENDS, NO_MODELS, normalizationTest, SOURCE, TENANT } from "./fixtures.ts";

const POLICY = `# 差旅费管理办法

## 第一章 总则

第一条 为规范公司差旅费管理，制定本办法。第二条 本办法适用于全体员工。

## 第二章 住宿标准

第三条 一线城市住宿标准为每晚 600 元。

| 城市 | 标准 |
| --- | --- |
| 北京 | 600 |
| 成都 | 450 |
`;

const ARTICLES = [
  "第四条 出差人员应优先乘坐公共交通工具，确需乘坐出租车的，凭票据据实报销。",
  "第五条 乘坐飞机须经部门负责人批准，一般乘坐经济舱。",
  "第六条 乘坐火车的，高级管理人员可乘坐一等座，其他人员乘坐二等座。",
  "第七条 自驾出差的，按每公里 1.2 元的标准给予补贴，不再报销过路费以外的其他费用。",
  "第八条 出差结束后十个工作日内，应在费控系统中提交报销申请并附上全部原始票据。",
].join("\n\n");

const blocksChanged = (events: EventEnvelope[]) =>
  events.filter((e) => e.type === "blocks.changed").map((e) => payloadOf(e, "blocks.changed"));

describe.each(BACKENDS)("normalization on $backend", ({ backend, skip }) => {
  const it = normalizationTest(backend);

  it.skipIf(skip)("a first version gets its blocks, spans and one blocks.changed", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "制度/差旅.md", text: POLICY });
    const result = await world.normalization.normalize(v1.id);
    expect(result.status).toBe("parsed");

    const blocks = await world.store.blocksOf(v1.id);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "table",
      "table_row",
      "table_row",
      "table_row",
    ]);
    const spans = await world.store.spansOf(v1.id);
    expect(spans.map((s) => s.text).slice(0, 3)).toEqual([
      "第一条 为规范公司差旅费管理，制定本办法。",
      "第二条 本办法适用于全体员工。",
      "第三条 一线城市住宿标准为每晚 600 元。",
    ]);
    const [changed, ...more] = blocksChanged(await world.events());
    expect(more).toEqual([]);
    expect(changed).toMatchObject({ source_id: SOURCE, source_version_id: v1.id, removed_block_ids: [] });
    expect(changed?.added_block_ids).toEqual(blocks.map((b) => b.id));
    expect(changed?.added_span_ids).toEqual(spans.map((s) => s.id));

    const [state] = await world.normalization.documents(SOURCE);
    expect(state).toMatchObject({ source_version_id: v1.id, status: "parsed", block_count: 9, span_count: 9 });
    expect(state?.parser).toEqual({ component: "normalization", name: "markdown", version: "1" });

    // Redelivery finds the version done.
    expect((await world.normalization.normalize(v1.id)).status).toBe("already_normalized");
    expect(blocksChanged(await world.events())).toHaveLength(1);
  });

  it.skipIf(skip)("blocks.changed carries on the correlation of the document.fetched it answers", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "差旅.md", text: POLICY });
    const fetched = newEvent(
      "document.fetched",
      {
        source_id: SOURCE,
        source_version_id: v1.id,
        external_id: "差旅.md",
        changed: { content: true, metadata: true, acl: true },
        deleted: false,
      },
      { tenantId: TENANT, producer: "source-sync" },
    );
    await world.normalization.onDocumentFetched(fetched);
    const [changed] = (await world.events()).filter((e) => e.type === "blocks.changed");
    expect(changed).toMatchObject({ causation_id: fetched.id, correlation_id: fetched.id });
  });

  it.skipIf(skip)("an edit changes one block and one span; the rest keep their IDs", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "差旅.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({ external_id: "差旅.md", text: POLICY.replace("每晚 600 元", "每晚 650 元") });
    const { diff } = await world.normalization.normalize(v2.id);
    const before = await world.store.blocksOf(v1.id);
    const after = await world.store.blocksOf(v2.id);
    const edited = before.find((b) => b.text.startsWith("第三条")) as (typeof before)[number];
    expect(diff).toMatchObject({
      previous_version_id: v1.id,
      added_block_ids: [],
      changed_block_ids: [edited.id],
      removed_block_ids: [],
      unchanged_block_count: 8,
    });
    expect(diff?.added_span_ids).toHaveLength(1);
    expect(diff?.removed_span_ids).toEqual(edited.span_ids);
    expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
    // Unchanged spans are stored once, under the version that introduced them.
    const spans = await world.store.spansOf(v2.id);
    expect(spans.filter((s) => s.source_version_id === v1.id)).toHaveLength(8);
    expect(spans.find((s) => s.text.includes("650"))?.source_version_id).toBe(v2.id);
  });

  it.skipIf(skip)(
    "a renamed heading changes the blocks under it, which keep their IDs and spans",
    async ({ world }) => {
      const v1 = await world.ingest({ external_id: "差旅.md", text: POLICY });
      await world.normalization.normalize(v1.id);
      const v2 = await world.ingest({
        external_id: "差旅.md",
        text: POLICY.replace("第二章 住宿标准", "第二章 出差补贴"),
      });
      const { diff } = await world.normalization.normalize(v2.id);
      const before = await world.store.blocksOf(v1.id);
      const after = await world.store.blocksOf(v2.id);
      // The paragraph and the table under the heading keep their IDs and are changed. A parsed
      // heading with other text is another block.
      const under = after.filter((b) => b.heading_path?.includes("第二章 出差补贴"));
      expect(under.map((b) => b.kind)).toEqual(["paragraph", "table", "table_row", "table_row", "table_row"]);
      const known = new Set(before.map((b) => b.id));
      expect(under.every((b) => known.has(b.id))).toBe(true);
      const heading = after.find((b) => b.text === "第二章 出差补贴")?.id;
      expect(diff?.added_block_ids).toEqual([heading]);
      expect(diff?.removed_block_ids).toEqual([before.find((b) => b.text === "第二章 住宿标准")?.id]);
      expect(diff?.changed_block_ids.sort()).toEqual(under.map((b) => b.id).sort());
      expect(diff?.unchanged_block_count).toBe(3);
      expect(diff?.added_span_ids).toEqual([]);
      expect(diff?.removed_span_ids).toEqual([]);
    },
  );

  it.skipIf(skip)("a metadata-only version reuses the blocks without parsing", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "差旅.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({ external_id: "差旅.md", text: POLICY, metadata: "approved" });
    const result = await world.normalization.normalize(v2.id);
    expect(result.status).toBe("unchanged");
    expect(result.diff).toMatchObject({ added_block_ids: [], changed_block_ids: [], unchanged_block_count: 9 });
    expect((await world.store.spansOf(v2.id)).map((s) => s.id)).toEqual(
      (await world.store.spansOf(v1.id)).map((s) => s.id),
    );
  });

  it.skipIf(skip)("a tombstone removes every block", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "差旅.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const gone = await world.ingest({ external_id: "差旅.md" }, { deleted: true });
    const { diff } = await world.normalization.normalize(gone.id);
    expect(diff?.deleted).toBe(true);
    expect(diff?.removed_block_ids).toHaveLength(9);
    expect(diff?.removed_span_ids).toHaveLength(9);
    expect((await world.normalization.documents(SOURCE))[0]?.status).toBe("deleted");
  });

  it.skipIf(skip)("copies of a document are reported as duplicates", async ({ world }) => {
    const policy = `${POLICY}\n## 第三章 交通\n\n${ARTICLES}`;
    const a = await world.ingest({ external_id: "制度/差旅.md", text: policy });
    await world.normalization.normalize(a.id);
    const copy = await world.ingest({ external_id: "归档/差旅（副本）.txt", text: policy.replaceAll("#", "") });
    const near = await world.ingest({
      external_id: "归档/差旅-旧版.md",
      text: policy.replace("每晚 600 元", "每晚 550 元").replace("全体员工", "全体正式员工"),
    });
    const other = await world.ingest({ external_id: "制度/会议.md", text: "# 会议室管理\n\n会议室须提前一天预订。" });
    expect((await world.normalization.normalize(copy.id)).diff?.duplicates).toEqual([
      { source_id: SOURCE, external_id: "制度/差旅.md", source_version_id: a.id, exact: true, similarity: 1 },
    ]);
    const nearDuplicates = (await world.normalization.normalize(near.id)).diff?.duplicates ?? [];
    expect(nearDuplicates.map((d) => [d.external_id, d.exact])).toEqual([
      ["制度/差旅.md", false],
      ["归档/差旅（副本）.txt", false],
    ]);
    expect(nearDuplicates[0]?.similarity).toBeGreaterThan(0.8);
    expect((await world.normalization.normalize(other.id)).diff?.duplicates).toBeUndefined();
  });

  it.skipIf(skip)("connector blocks keep their native IDs; approval definitions become blocks", async ({ world }) => {
    const blocks = (text: string) => [
      { anchor: "doxH1", kind: "heading" as const, level: 1, text: "报销流程" },
      { anchor: "doxP1", kind: "paragraph" as const, text },
    ];
    const v1 = await world.ingest({ external_id: "doxcnA", blocks: blocks("先提交申请。") });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({ external_id: "doxcnA", blocks: blocks("全部改写的新内容，与原文无关。") });
    const { diff } = await world.normalization.normalize(v2.id);
    expect(diff?.changed_block_ids).toHaveLength(1);
    expect(diff?.added_block_ids).toEqual([]);

    const approval = await world.ingest({
      external_id: "APPROVAL-TRAVEL",
      process: {
        definition: {
          code: "APPROVAL-TRAVEL",
          name: "出差申请",
          form_fields: [{ key: "city", label: "目的城市", options: ["北京", "成都"], required: true }],
          nodes: [
            { key: "start", name: "发起", node_type: "start" },
            { key: "manager", name: "直属上级审批", node_type: "approval" },
          ],
        },
        instances: [],
      },
    });
    expect((await world.normalization.normalize(approval.id)).status).toBe("structured");
    const steps = await world.store.blocksOf(approval.id);
    expect(steps.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "出差申请"],
      ["form_field", "目的城市: 北京 / 成都"],
      ["list_item", "发起"],
      ["list_item", "直属上级审批"],
    ]);
    const [field] = await world.store.spansOf(approval.id);
    expect(field?.locator).toMatchObject({ kind: "form_field", field_key: "city" });
  });

  it.skipIf(skip)("a file that fails to parse leaves the last good version as the base", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "表.csv", text: "部门,限额\n财务部,500\n" });
    await world.normalization.normalize(v1.id);
    const broken = await world.ingest({ external_id: "表.csv", text: '部门,"限额\n' });
    expect((await world.normalization.normalize(broken.id)).status).toBe("failed");
    const [state] = await world.normalization.documents(SOURCE);
    expect(state?.source_version_id).toBe(v1.id);
    expect(state?.failed?.source_version_id).toBe(broken.id);
    const v3 = await world.ingest({ external_id: "表.csv", text: "部门,限额\n财务部,600\n" });
    const { diff } = await world.normalization.normalize(v3.id);
    expect(diff?.previous_version_id).toBe(v1.id);
    expect(diff?.changed_block_ids).toHaveLength(2); // the table and its second row
  });

  it.skipIf(skip)("files without a parser are noted, not retried", async ({ world }) => {
    const pdf = await world.ingest({ external_id: "扫描件.pdf", text: "%PDF-1.7" });
    expect((await world.normalization.normalize(pdf.id)).status).toBe("unsupported");
    expect((await world.normalization.documents(SOURCE))[0]?.warnings).toEqual(["no parser for application/pdf"]);
  });

  it.skipIf(skip)("document.fetched is handled under the normalization group", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "a.md", text: "# A\n\n正文。" });
    const event = newEvent(
      "document.fetched",
      {
        source_id: SOURCE,
        source_version_id: v1.id,
        external_id: "a.md",
        changed: { content: true, metadata: true, acl: true },
        deleted: false,
        needs_parsing: true,
      },
      { tenantId: TENANT, producer: "source-sync" },
    );
    await world.normalization.handlers()["document.fetched"]?.(event);
    expect(await world.store.blocksOf(v1.id)).toHaveLength(2);
  });
});

test("the built-in parsers are declared plugins, and the router picks the best", async () => {
  expect(registry("parsers").names()).toEqual(expect.arrayContaining(["csv", "html", "markdown", "text"]));
  const store = new MemoryStore();
  const normalization = new Normalization({
    store,
    records: new MemoryRecords(),
    blobs: new LocalBlobStore("/nonexistent"),
    models: NO_MODELS,
  });
  const pick = async (mime_type: string, filename?: string) =>
    (await normalization.parserFor({ mime_type, size_bytes: 1, ...(filename && { filename }) }))?.name;
  expect(await pick("text/markdown")).toBe("markdown");
  expect(await pick("text/plain")).toBe("text");
  expect(await pick("text/x-unknown")).toBe("text");
  expect(await pick("application/octet-stream", "readme.md")).toBe("markdown");
  expect(await pick("application/pdf")).toBeUndefined();

  const better: Parser = { name: "better-markdown", version: "1", accepts: () => 2, parse: async () => ({}) as never };
  const custom = new Normalization({
    store,
    records: new MemoryRecords(),
    blobs: new LocalBlobStore("/nonexistent"),
    models: NO_MODELS,
    parsers: [better],
  });
  expect((await custom.parserFor({ mime_type: "text/markdown", size_bytes: 1 }))?.name).toBe("better-markdown");
});
