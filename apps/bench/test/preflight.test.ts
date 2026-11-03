import type { Corpus, Engine } from "@inspiration/engine";
import { describe, expect, test } from "vitest";
import { catalogueCoverage, coverageLines, readableDocuments } from "../src/preflight.ts";
import type { Keys } from "../src/questions.ts";

const keys = (...facts: string[]) =>
  ({ asked_on: "2026-11-02", facts: Object.fromEntries(facts.map((f) => [f, { about: f, values: [] }])) }) as Keys;
const catalogue = (...predicates: string[]) =>
  ({ vocabulary: { predicates: predicates.map((predicate) => ({ predicate })) } }) as unknown as Corpus;

describe("what a paid run checks before it pays", () => {
  test("a keyed fact counts as catalogued by its predicate, whatever its subject and qualifiers", () => {
    const c = catalogueCoverage(catalogue("hotel_cap"), keys("acme/hotel_cap|us", "tips_limit", "hotel_cap"));
    expect(c).toEqual({ facts: 3, uncatalogued: ["tips_limit"] });
    expect(coverageLines(c, false).start).toBe(true);
    expect(coverageLines(c, false).lines.join()).toContain("1 of 3 keyed facts have no catalogue entry");
  });

  test("a run whose catalogue names none of its keyed facts does not start unless told to", () => {
    const none = catalogueCoverage({} as Corpus, keys("hotel_cap", "tips_limit"));
    expect(none.uncatalogued).toEqual(["hotel_cap", "tips_limit"]);
    expect(coverageLines(none, false).start).toBe(false);
    expect(coverageLines(none, true).start).toBe(true);
    expect(coverageLines(catalogueCoverage(catalogue("hotel_cap"), keys("hotel_cap")), false)).toEqual({
      lines: [],
      start: true,
    });
  });

  test("only indexed documents the reader may read count, and deleted ones are left out", async () => {
    const asked: string[] = [];
    const engine = {
      retrieval: {
        documents: async () => [
          { document: "src_a:one.md", chunk_ids: [] },
          { document: "src_a:two.md", chunk_ids: [] },
          { document: "src_a:gone.md", chunk_ids: [], deleted: true },
        ],
      },
      authz: {
        checkMany: async (_who: unknown, _perm: unknown, resources: { id: string }[]) => {
          asked.push(...resources.map((r) => r.id));
          return resources.map((r) => ({ allow: r.id === "src_a:one.md" }));
        },
      },
    } as unknown as Engine;
    const corpus = { reader: { tenant_id: "ten_01PREFLIGHT000000000TENANT" } } as unknown as Corpus;
    expect(await readableDocuments(engine, corpus)).toEqual({ indexed: 2, readable: 1 });
    expect(asked).toEqual(["src_a:one.md", "src_a:two.md"]);
  });
});
