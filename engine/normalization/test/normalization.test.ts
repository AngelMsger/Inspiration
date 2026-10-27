import { type EventEnvelope, newEvent, type Parser, payloadOf } from "@inspiration/contracts";
import { MemoryRecords } from "@inspiration/eventbus";
import { LocalBlobStore, registry } from "@inspiration/kernel";
import { MemoryStore } from "@inspiration/knowledge-store";
import { describe, expect, test } from "vitest";
import { EDITION_SHARE, NEAR_SHARE, Normalization } from "../src/index.ts";
import { BACKENDS, NO_MODELS, normalizationTest, SOURCE, TENANT } from "./fixtures.ts";

const POLICY = `# Travel policy

## Chapter 1 General provisions

Article 1 This policy governs the company's travel expenses. Article 2 This policy applies to all staff.

## Chapter 2 Hotel standards

Article 3 The hotel standard in tier-1 cities is 600 yuan a night.

| City | Standard |
| --- | --- |
| Beijing | 600 |
| Chengdu | 450 |
`;

const ARTICLES = [
  "Article 4 Travellers take public transport where they can; a taxi that is really needed is refunded against its receipt.",
  "Article 5 Flights need the department head's approval and are normally in economy class.",
  "Article 6 On trains, senior managers may travel first class and everyone else second class.",
  "Article 7 Trips by one's own car are paid 1.2 yuan a kilometre, and nothing beyond tolls is refunded.",
  "Article 8 Within ten working days after a trip, file the claim in the expense system with every original receipt.",
].join("\n\n");

const blocksChanged = (events: EventEnvelope[]) =>
  events.filter((e) => e.type === "blocks.changed").map((e) => payloadOf(e, "blocks.changed"));

describe.each(BACKENDS)("normalization on $backend", ({ backend, skip }) => {
  const it = normalizationTest(backend);

  it.skipIf(skip)("a first version gets its blocks, spans and one blocks.changed", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "policies/travel.md", text: POLICY });
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
      "Article 1 This policy governs the company's travel expenses.",
      "Article 2 This policy applies to all staff.",
      "Article 3 The hotel standard in tier-1 cities is 600 yuan a night.",
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
    const v1 = await world.ingest({ external_id: "travel.md", text: POLICY });
    const fetched = newEvent(
      "document.fetched",
      {
        source_id: SOURCE,
        source_version_id: v1.id,
        external_id: "travel.md",
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
    const v1 = await world.ingest({ external_id: "travel.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({
      external_id: "travel.md",
      text: POLICY.replace("600 yuan a night", "650 yuan a night"),
    });
    const { diff } = await world.normalization.normalize(v2.id);
    const before = await world.store.blocksOf(v1.id);
    const after = await world.store.blocksOf(v2.id);
    const edited = before.find((b) => b.text.startsWith("Article 3")) as (typeof before)[number];
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
      const v1 = await world.ingest({ external_id: "travel.md", text: POLICY });
      await world.normalization.normalize(v1.id);
      const v2 = await world.ingest({
        external_id: "travel.md",
        text: POLICY.replace("Chapter 2 Hotel standards", "Chapter 2 Travel allowances"),
      });
      const { diff } = await world.normalization.normalize(v2.id);
      const before = await world.store.blocksOf(v1.id);
      const after = await world.store.blocksOf(v2.id);
      // The paragraph and the table under the heading keep their IDs and are changed. A parsed
      // heading with other text is another block.
      const under = after.filter((b) => b.heading_path?.includes("Chapter 2 Travel allowances"));
      expect(under.map((b) => b.kind)).toEqual(["paragraph", "table", "table_row", "table_row", "table_row"]);
      const known = new Set(before.map((b) => b.id));
      expect(under.every((b) => known.has(b.id))).toBe(true);
      const heading = after.find((b) => b.text === "Chapter 2 Travel allowances")?.id;
      expect(diff?.added_block_ids).toEqual([heading]);
      expect(diff?.removed_block_ids).toEqual([before.find((b) => b.text === "Chapter 2 Hotel standards")?.id]);
      expect(diff?.changed_block_ids.sort()).toEqual(under.map((b) => b.id).sort());
      expect(diff?.unchanged_block_count).toBe(3);
      expect(diff?.added_span_ids).toEqual([]);
      expect(diff?.removed_span_ids).toEqual([]);
    },
  );

  it.skipIf(skip)("a metadata-only version reuses the blocks without parsing", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "travel.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({ external_id: "travel.md", text: POLICY, metadata: "approved" });
    const result = await world.normalization.normalize(v2.id);
    expect(result.status).toBe("unchanged");
    expect(result.diff).toMatchObject({ added_block_ids: [], changed_block_ids: [], unchanged_block_count: 9 });
    expect((await world.store.spansOf(v2.id)).map((s) => s.id)).toEqual(
      (await world.store.spansOf(v1.id)).map((s) => s.id),
    );
  });

  it.skipIf(skip)("a tombstone removes every block", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "travel.md", text: POLICY });
    await world.normalization.normalize(v1.id);
    const gone = await world.ingest({ external_id: "travel.md" }, { deleted: true });
    const { diff } = await world.normalization.normalize(gone.id);
    expect(diff?.deleted).toBe(true);
    expect(diff?.removed_block_ids).toHaveLength(9);
    expect(diff?.removed_span_ids).toHaveLength(9);
    expect((await world.normalization.documents(SOURCE))[0]?.status).toBe("deleted");
  });

  it.skipIf(skip)("copies of a document are reported as duplicates", async ({ world }) => {
    const policy = `${POLICY}\n## Chapter 3 Transport\n\n${ARTICLES}`;
    const a = await world.ingest({ external_id: "policies/travel.md", text: policy });
    await world.normalization.normalize(a.id);
    const copy = await world.ingest({ external_id: "archive/travel (copy).txt", text: policy.replaceAll("#", "") });
    const near = await world.ingest({
      external_id: "archive/travel-old.md",
      text: policy.replace("600 yuan a night", "550 yuan a night").replace("all staff", "all permanent staff"),
    });
    const other = await world.ingest({
      external_id: "policies/meetings.md",
      text: "# Meeting rooms\n\nMeeting rooms are booked a day ahead.",
    });
    expect((await world.normalization.normalize(copy.id)).diff?.duplicates).toEqual([
      { source_id: SOURCE, external_id: "policies/travel.md", source_version_id: a.id, exact: true, similarity: 1 },
    ]);
    const nearDuplicates = (await world.normalization.normalize(near.id)).diff?.duplicates ?? [];
    expect(nearDuplicates.map((d) => [d.external_id, d.exact])).toEqual([
      ["policies/travel.md", false],
      ["archive/travel (copy).txt", false],
    ]);
    expect(nearDuplicates[0]?.similarity).toBeGreaterThan(0.8);
    expect((await world.normalization.normalize(other.id)).diff?.duplicates).toBeUndefined();
  });

  it.skipIf(skip)("an edition revised for years is reported under the same title only", async ({ world }) => {
    const places = ["Beijing", "Shanghai", "Chengdu", "Wuhan", "Xi'an", "Shenzhen"];
    const rules = (raise: number) =>
      Array.from({ length: 24 }, (_, i) => {
        const amount = 100 + i * 10 + (i % 3 ? raise : 0);
        return `Rule ${i + 1} sets the daily allowance for trips to ${places[i % 6]} at grade ${(i % 4) + 1} to ${amount} yuan.`;
      }).join("\n\n");
    const current = await world.ingest({ external_id: "policies/allowances.md", title: "Allowances", text: rules(20) });
    await world.normalization.normalize(current.id);
    // Last year's edition: two in three amounts have been raised since.
    const kept = await world.ingest({ external_id: "downloads/allowances.md", title: "Allowances", text: rules(0) });
    const [edition, ...more] = (await world.normalization.normalize(kept.id)).diff?.duplicates ?? [];
    expect(more).toEqual([]);
    expect(edition).toMatchObject({ external_id: "policies/allowances.md", exact: false });
    expect(edition?.similarity).toBeGreaterThan(EDITION_SHARE);
    expect(edition?.similarity).toBeLessThan(NEAR_SHARE);
    // The same text under another title is another document that repeats a third of this one.
    const renamed = await world.ingest({ external_id: "hr/rates.md", title: "Grade rates", text: rules(0) });
    const found = (await world.normalization.normalize(renamed.id)).diff?.duplicates ?? [];
    expect(found.map((d) => [d.external_id, d.exact])).toEqual([["downloads/allowances.md", true]]);
  });

  it.skipIf(skip)("connector blocks keep their native IDs; approval definitions become blocks", async ({ world }) => {
    const blocks = (text: string) => [
      { anchor: "doxH1", kind: "heading" as const, level: 1, text: "Expense claims" },
      { anchor: "doxP1", kind: "paragraph" as const, text },
    ];
    const v1 = await world.ingest({ external_id: "doxcnA", blocks: blocks("File the request first.") });
    await world.normalization.normalize(v1.id);
    const v2 = await world.ingest({
      external_id: "doxcnA",
      blocks: blocks("Rewritten throughout, unrelated to the original."),
    });
    const { diff } = await world.normalization.normalize(v2.id);
    expect(diff?.changed_block_ids).toHaveLength(1);
    expect(diff?.added_block_ids).toEqual([]);

    const approval = await world.ingest({
      external_id: "APPROVAL-TRAVEL",
      process: {
        definition: {
          code: "APPROVAL-TRAVEL",
          name: "Trip request",
          form_fields: [{ key: "city", label: "Destination", options: ["Beijing", "Chengdu"], required: true }],
          nodes: [
            { key: "start", name: "Start", node_type: "start" },
            { key: "manager", name: "Manager approval", node_type: "approval" },
          ],
        },
        instances: [],
      },
    });
    expect((await world.normalization.normalize(approval.id)).status).toBe("structured");
    const steps = await world.store.blocksOf(approval.id);
    expect(steps.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "Trip request"],
      ["form_field", "Destination: Beijing / Chengdu"],
      ["list_item", "Start"],
      ["list_item", "Manager approval"],
    ]);
    const [field] = await world.store.spansOf(approval.id);
    expect(field?.locator).toMatchObject({ kind: "form_field", field_key: "city" });
  });

  it.skipIf(skip)("a file that fails to parse leaves the last good version as the base", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "caps.csv", text: "department,cap\nfinance,500\n" });
    await world.normalization.normalize(v1.id);
    const broken = await world.ingest({ external_id: "caps.csv", text: 'department,"cap\n' });
    expect((await world.normalization.normalize(broken.id)).status).toBe("failed");
    const [state] = await world.normalization.documents(SOURCE);
    expect(state?.source_version_id).toBe(v1.id);
    expect(state?.failed?.source_version_id).toBe(broken.id);
    const v3 = await world.ingest({ external_id: "caps.csv", text: "department,cap\nfinance,600\n" });
    const { diff } = await world.normalization.normalize(v3.id);
    expect(diff?.previous_version_id).toBe(v1.id);
    expect(diff?.changed_block_ids).toHaveLength(2); // the table and its second row
  });

  it.skipIf(skip)("files without a parser are noted, not retried", async ({ world }) => {
    const pdf = await world.ingest({ external_id: "scan.pdf", text: "%PDF-1.7" });
    expect((await world.normalization.normalize(pdf.id)).status).toBe("unsupported");
    expect((await world.normalization.documents(SOURCE))[0]?.warnings).toEqual(["no parser for application/pdf"]);
  });

  it.skipIf(skip)("document.fetched is handled under the normalization group", async ({ world }) => {
    const v1 = await world.ingest({ external_id: "a.md", text: "# A\n\nThe text." });
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
