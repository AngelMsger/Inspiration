import { slotOf } from "@inspiration/contracts";
import type { FakeProvider } from "@inspiration/model-gateway";
import { assert, describe, expect, vi } from "vitest";
import { FactDiscovery } from "../src/discovery.ts";
import { Extraction, type PredicateEntry } from "../src/index.ts";
import { windowsOf } from "../src/windows.ts";
import { BACKENDS, extractionTest, TENANT } from "./fixtures.ts";

describe.each(BACKENDS)("$backend cold start", ({ backend, skip }) => {
  const test = extractionTest(backend, { discoverFacts: true, emptyCatalogue: true });
  describe.skipIf(skip)("discovery", () => {
    test("an empty catalogue learns a fact, reuses it across documents and survives reopening", async ({ world }) => {
      const first = await world.version("policy.md", [{ id: "p", text: "Leave allowance: 20 days." }], {
        level: "governed",
      });
      const [claim] = await world.store.getClaims(first.result.added);
      expect(claim?.value?.number).toBe(20);
      expect(slotOf(claim ?? {})).toBeTruthy();
      const second = await world.version("notice.md", [{ id: "p", text: "Leave allowance: 25 days." }], {
        level: "governed",
      });
      const [other] = await world.store.getClaims(second.result.added);
      expect(other?.value?.number).toBe(25);
      expect(slotOf(other ?? {})).toBe(slotOf(claim ?? {}));
      const reopened = new Extraction({
        store: world.store,
        records: world.records,
        models: world.gateway,
        discoverFacts: true,
      });
      expect((await reopened.extract(second.change)).added).toEqual([]);
      const discovery = new FactDiscovery(world.records, world.gateway, reopened.prompts);
      expect(await discovery.catalogue(TENANT, first.version.space_id, "internal")).toHaveLength(1);
      expect(await discovery.catalogue(TENANT, "spc_00000000OTHER", "internal")).toEqual([]);
      expect(await discovery.catalogue(TENANT, first.version.space_id, "secret")).toEqual([]);
    });

    test("reference reading waits for use, and search-only never discovers facts", async ({ world }) => {
      const reference = await world.version("reference.md", [{ id: "p", text: "Leave allowance: 20 days." }], {
        level: "reference",
      });
      expect(reference.result.added).toEqual([]);
      const used = await world.extraction.extractOnUse(reference.version.id, reference.change.added_block_ids);
      expect((await world.store.getClaims(used.added))[0]?.value?.number).toBe(20);
      const ignored = await world.version("search.md", [{ id: "p", text: "Meal allowance: 50 credits." }], {
        level: "search_only",
      });
      expect(ignored.result.windows).toBe(0);
      expect((await world.extraction.extractOnUse(ignored.version.id, ignored.change.added_block_ids)).added).toEqual(
        [],
      );
    });

    test("on-use citations follow the current version and commit before their standing handler runs", async ({
      world,
    }) => {
      const first = await world.version(
        "reference.md",
        [
          { id: "leave", text: "Leave allowance: 20 days." },
          { id: "meal", text: "Meal allowance: 40 credits." },
        ],
        { level: "reference" },
      );
      const latest = await world.version(
        "reference.md",
        [
          { id: "leave", text: "Leave allowance: 25 days." },
          { id: "meal", text: "Meal allowance: 40 credits." },
        ],
        { level: "reference" },
      );
      const spans = await world.store.getSpans(first.change.added_span_ids);
      const meal = spans.find((span) => span.text.includes("Meal allowance"));
      assert(meal);
      const citations = [{ source_version_id: latest.version.id, span_id: meal.id }];
      const committed = vi.fn(async (event) => {
        expect((await world.events()).some((stored) => stored.id === event.id)).toBe(true);
      });
      expect(await world.extraction.extractCitations("ten_00000000OTHER", citations, committed)).toEqual([]);
      const [read] = await world.extraction.extractCitations(TENANT, citations, committed);
      expect((await world.store.getClaims(read?.added ?? []))[0]?.value?.number).toBe(40);
      expect(committed).toHaveBeenCalledTimes(1);
      await world.extraction.extractCitations(TENANT, citations, committed);
      expect(committed).toHaveBeenCalledTimes(1);
    });

    test("configured vocabulary stays authoritative and is never persisted as discovered vocabulary", async ({
      world,
    }) => {
      const document = await world.version("reference.md", [{ id: "p", text: "Leave allowance: 20 days." }], {
        level: "reference",
      });
      const [window] = await windowsOf(world.store, document.version, new Set(document.change.added_block_ids), 1500);
      assert(window);
      const supplied: PredicateEntry = {
        predicate: "leave_allowance",
        label: "Configured allowance",
        aliases: ["Leave allowance"],
        value: { kind: "number", unit: "day", words: ["days"] },
      };
      const reply = JSON.stringify({
        predicates: [
          {
            ...supplied,
            label: "Model label",
            aliases: ["allowance"],
            evidence: [{ span: "s1", quote: "Leave allowance: 20 days." }],
          },
        ],
      });
      for (const name of ["cloud", "local"])
        world.gateway.provider<FakeProvider>(name).script("extraction.discover_facts", reply);
      const discovery = new FactDiscovery(world.records, world.gateway, world.extraction.prompts);
      expect(await discovery.discover(document.version, window, [supplied])).toEqual([supplied]);
      expect(await discovery.catalogue(TENANT, document.version.space_id, "internal")).toEqual([]);
      // Removing a configured entry must not bring it back from discovery's stored state.
      expect(await discovery.discover(document.version, window, [])).toEqual([]);
    });

    test("discovery merges evidenced wording without losing earlier predicate or qualifier aliases", async ({
      world,
    }) => {
      const documents = await Promise.all(
        ["US", "United States"].map((region, i) =>
          world.version(`reference-${i}.md`, [{ id: "p", text: `${region} leave allowance: 20 days.` }], {
            level: "reference",
          }),
        ),
      );
      const discovery = new FactDiscovery(world.records, world.gateway, world.extraction.prompts);
      for (const [i, document] of documents.entries()) {
        const region = i === 0 ? "US" : "United States";
        const [window] = await windowsOf(world.store, document.version, new Set(document.change.added_block_ids), 1500);
        assert(window);
        const reply = JSON.stringify({
          predicates: [
            {
              predicate: "leave_allowance",
              label: "Leave allowance",
              aliases: [`${region} leave allowance`],
              qualifiers: [{ name: "us", aliases: [region, "Unevidenced alias"] }],
              value: { kind: "number", unit: "days", words: ["days"] },
              evidence: [{ span: "s1", quote: `${region} leave allowance: 20 days.` }],
            },
          ],
        });
        for (const name of ["cloud", "local"])
          world.gateway.provider<FakeProvider>(name).script("extraction.discover_facts", reply);
        await discovery.discover(document.version, window, []);
      }
      const [entry] = await discovery.catalogue(TENANT, documents[0]?.version.space_id ?? "", "internal");
      expect(entry?.aliases).toEqual(["US leave allowance", "United States leave allowance"]);
      expect(entry?.qualifiers).toEqual([{ name: "us", aliases: ["US", "United States"] }]);
    });

    test("a catalogue proposal with fabricated evidence cannot give a claim a slot", async ({ world }) => {
      const reply = JSON.stringify({
        predicates: [
          {
            predicate: "leave_allowance",
            label: "Leave allowance",
            aliases: ["Leave allowance"],
            value: { kind: "number", unit: "days", words: ["days"] },
            evidence: [{ span: "s1", quote: "This quote was invented." }],
          },
        ],
      });
      for (const name of ["cloud", "local"])
        world.gateway.provider<FakeProvider>(name).script("extraction.discover_facts", reply);
      const result = await world.version("policy.md", [{ id: "p", text: "Leave allowance: 20 days." }], {
        level: "governed",
      });
      expect((await world.store.getClaims(result.result.added)).every((c) => !slotOf(c))).toBe(true);
      const discovery = new FactDiscovery(world.records, world.gateway, world.extraction.prompts);
      expect(await discovery.catalogue(TENANT, result.version.space_id, "internal")).toEqual([]);
    });
  });
});
