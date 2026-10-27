// Retrieval against the in-memory doubles and Postgres (pgvector, pg_search).

import { GatewayException, type SlotVerdict } from "@inspiration/contracts";
import { testData } from "@inspiration/testkit";
import { describe, expect, vi } from "vitest";
import { ContextTooLong, chunk, MAX_TOKENS } from "../src/index.ts";
import { ALICE, BACKENDS, BOB, CAROL, cap, HOTEL, retrievalTest, SPACE, TENANT } from "./fixtures.ts";

interface Cases {
  answers: {
    question: string;
    policy: string;
    copy: string;
    /** Part of the note an answer gives on the copy's outdated value. */
    outdated: string;
    /** What the answer says when nothing answers the question. */
    nothing: string;
    unrelated: string;
  };
}

const LANGUAGES = ["en", "zh", "ja"].map((tag) => ({ tag, cases: testData<Cases>(import.meta.url, `${tag}.yaml`) }));

const POLICY = [
  { id: "h1", text: "Lodging", heading: true },
  { id: "p1", text: "Hotels in tier-1 cities cost at most 650 yuan a night. Book through the travel desk." },
  { id: "h2", text: "Meals", heading: true },
  { id: "p2", text: "Meals are paid at 100 yuan a day. Keep every receipt." },
];

const verdict = (held: { value: string; claim: string }, outdated: { value: string; claim: string }): SlotVerdict => ({
  tenant_id: TENANT,
  slot_key: HOTEL,
  held_value: held.value,
  disputed: false,
  values: [
    { value: held.value, standing: "holds", claim_ids: [held.claim] },
    { value: outdated.value, standing: "outdated", claim_ids: [outdated.claim] },
  ],
  decided_on: "2026-10-01",
});

describe("chunks", () => {
  const span = (id: string, text: string) => ({
    id,
    tenant_id: TENANT,
    source_version_id: "sv_01JC00000000000000000000001",
    locator: { block_anchor: id, kind: "text_range" as const },
    text,
    text_hash: "sha256:0",
    ordinal: 0,
  });
  const block = (id: string, text: string, spanIds: string[], heading = false) => ({
    id: `blk_${id.padStart(8, "0")}`,
    tenant_id: TENANT,
    source_version_id: "sv_01JC00000000000000000000001",
    kind: heading ? ("heading" as const) : ("paragraph" as const),
    anchor: id,
    text,
    text_hash: "sha256:0",
    ordinal: Number(id),
    span_ids: spanIds,
  });
  const doc = { tenantId: TENANT, sourceId: "src_01JC0000000000000000FOLDER", externalId: "a.md" };

  retrievalTest("memory")("headings travel with the text below them, and a long block is cut between spans", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} says something about the travel policy here.`);
    const spans = new Map(
      long.map((t, i) => [`spn_${String(i).padStart(8, "0")}`, span(`spn_${String(i).padStart(8, "0")}`, t)]),
    );
    const ids = [...spans.keys()];
    const drafts = chunk(doc, [block("1", "Travel", [], true), block("2", long.join(" "), ids)], spans);
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts[0]?.text.startsWith("Travel\n")).toBe(true);
    expect(drafts.flatMap((d) => d.span_ids)).toEqual(ids);
    for (const d of drafts) expect(d.token_count).toBeLessThanOrEqual(MAX_TOKENS);
    // The same text gives the same IDs.
    expect(
      chunk(doc, [block("1", "Travel", [], true), block("2", long.join(" "), ids)], spans).map((d) => d.id),
    ).toEqual(drafts.map((d) => d.id));
  });
});

describe.each(BACKENDS)("retrieval on $backend", ({ backend, skip }) => {
  const test = retrievalTest(backend);

  describe.skipIf(skip)("", () => {
    test("a passage is found by its words, under the headers it was given", async ({ world }) => {
      const first = await world.document("travel.md", POLICY, { title: "Travel policy" });
      const result = await world.retrieval.search({ text: "hotel tier-1 cities night", kinds: ["chunk"] }, ALICE);
      expect(result.hits[0]).toMatchObject({ kind: "chunk", title: expect.stringContaining("Travel policy") });
      expect(result.hits[0]?.snippet).toContain("650 yuan a night");
      expect(result.hits[0]?.citations[0]).toMatchObject({
        source_title: "Travel policy",
        source_version_id: first.version.id,
      });
      const [indexed] = await world.retrieval.documents(TENANT);
      const [one] = await world.store.getChunks(indexed?.chunk_ids ?? []);
      expect(one?.contextual_header).toBe("Travel policy: Lodging.");
      expect(one?.acl_tokens).toEqual([`system:${TENANT}`, `tenant:${TENANT}`]);
    });

    test("an edit keeps the chunks it left alone, with their headers and embeddings", async ({ world }) => {
      // Two sections, each a chunk of its own.
      const long = (topic: string) =>
        Array.from({ length: 40 }, (_, i) => `Rule ${i} of ${topic} applies to every trip.`).join(" ");
      const paras = [
        { id: "h1", text: "Lodging", heading: true },
        { id: "p1", text: long("lodging") },
        { id: "h2", text: "Meals", heading: true },
        { id: "p2", text: long("meals") },
      ];
      await world.document("travel.md", paras, { title: "Travel policy" });
      const [first] = await world.retrieval.documents(TENANT);
      expect(first?.chunk_ids).toHaveLength(2);
      const embedded = world.retrieval.totals.embedded;

      const edited = [...paras.slice(0, 3), { id: "p2", text: `${long("meals")} Taxis are paid in full after 22:00.` }];
      await world.document("travel.md", edited, { title: "Travel policy" });
      const [second] = await world.retrieval.documents(TENANT);
      expect(second?.chunk_ids[0]).toBe(first?.chunk_ids[0]);
      expect(second?.chunk_ids[1]).not.toBe(first?.chunk_ids[1]);
      expect(world.retrieval.totals.embedded - embedded).toBe(1);
      const kept = await world.store.getChunks([second?.chunk_ids[0] as string]);
      expect(kept[0]).toMatchObject({
        source_version_id: second?.source_version_id,
        contextual_header: "Travel policy: Lodging.",
      });
      expect(await world.store.getChunks([first?.chunk_ids[1] as string])).toEqual([]);
      const again = await world.retrieval.search({ text: "taxis after 22:00", kinds: ["chunk"] }, ALICE);
      expect(again.hits[0]?.snippet).toContain("Taxis are paid in full");
    });

    test("statements come with the passages that quote them, marked with where their value stands", async ({
      world,
    }) => {
      const policy = await world.document("travel.md", POLICY, { title: "Travel policy" });
      const handbook = await world.document(
        "handbook.md",
        [{ id: "p1", text: "Hotels in tier-1 cities cost at most 600 yuan a night." }],
        { title: "Old handbook" },
      );
      const held = await world.claim(
        "Hotels in tier-1 cities cost at most 650 yuan a night.",
        policy.spansOf("p1")[0] as never,
        cap(650),
      );
      const old = await world.claim(
        "Hotels in tier-1 cities cost at most 600 yuan a night.",
        handbook.spansOf("p1")[0] as never,
        cap(600),
      );
      world.verdicts.set(
        HOTEL,
        verdict({ value: "650 CNY/night", claim: held.id }, { value: "600 CNY/night", claim: old.id }),
      );

      const { hits } = await world.retrieval.search({ text: "hotel cap tier-1 cities", kinds: ["claim"] }, ALICE);
      expect(hits.map((h) => [h.unit_id, h.standing])).toEqual([
        [held.id, "holds"],
        [old.id, "outdated"],
      ]);
      expect(hits[1]).toMatchObject({ held_unit_id: held.id, slot_key: HOTEL, title: "Old handbook", space_id: SPACE });
      expect(hits[0]?.citations).toMatchObject([{ quote: "Hotels in tier-1 cities cost at most 650 yuan a night." }]);

      // A budget cuts the list, keeping at least one hit.
      const cut = await world.retrieval.search(
        { text: "hotel cap tier-1 cities", token_budget: 100, top_k: 20 },
        ALICE,
      );
      expect(cut.token_estimate).toBeLessThanOrEqual(100);
      expect(cut.hits.length).toBeGreaterThan(0);
    });

    test("nobody finds what they cannot read, and a statement cites only readable evidence", async ({ world }) => {
      const secret = await world.document(
        "board.md",
        [{ id: "p1", text: "The board approved hotels at most 900 yuan a night for directors." }],
        { title: "Board minutes", readers: [ALICE] },
      );
      const shared = await world.document(
        "faq.md",
        [{ id: "p1", text: "Directors' hotels: at most 900 yuan a night." }],
        {
          title: "Travel FAQ",
        },
      );
      const hidden = await world.claim(
        "Directors may book hotels at 900 yuan a night.",
        secret.spansOf("p1")[0] as never,
      );
      const both = await world.claim(
        "Directors' hotels cost at most 900 yuan a night.",
        secret.spansOf("p1")[0] as never,
      );
      await world.store.transaction((tx) =>
        tx.upsertClaims(
          [],
          [
            {
              claim_id: both.id,
              span_id: shared.spansOf("p1")[0]?.id as string,
              source_version_id: shared.version.id,
              role: "supports",
              quote: "Directors' hotels: at most 900 yuan a night.",
            },
          ],
        ),
      );

      const forAlice = await world.retrieval.search({ text: "directors hotels 900 yuan" }, ALICE);
      expect(forAlice.hits.map((h) => h.unit_id)).toEqual(expect.arrayContaining([hidden.id, both.id]));
      const forBob = await world.retrieval.search({ text: "directors hotels 900 yuan" }, BOB);
      const ids = forBob.hits.map((h) => h.unit_id);
      expect(ids).not.toContain(hidden.id);
      expect(forBob.hits.filter((h) => h.kind === "chunk").map((h) => h.title)).toEqual(["Travel FAQ"]);
      const cited = forBob.hits.find((h) => h.unit_id === both.id);
      expect(cited?.citations.map((c) => c.source_title)).toEqual(["Travel FAQ"]);

      // Shared with Bob later: the chunks take the new ACL.
      await world.share("board.md", [ALICE, BOB]);
      const later = await world.retrieval.search({ text: "directors hotels 900 yuan" }, BOB);
      expect(later.hits.map((h) => h.unit_id)).toContain(hidden.id);
    });

    test("a confidential document is found only by those cleared for it", async ({ world }) => {
      await world.document("salaries.md", [{ id: "p1", text: "Grade 7 salaries start at 30,000 yuan a month." }], {
        title: "Salary bands",
        sensitivity: "confidential",
      });
      expect((await world.retrieval.search({ text: "grade 7 salaries" }, BOB)).hits).toEqual([]);
      expect((await world.retrieval.search({ text: "grade 7 salaries" }, CAROL)).hits[0]?.title).toBe("Salary bands");
    });

    test("a rerank is labelled as the most sensitive text it sends; with no reranker cleared for it the fused order stands", async ({
      world,
    }) => {
      await world.document("salaries.md", [{ id: "p1", text: "Grade 7 salaries start at 314159 yuan a month." }], {
        title: "Salary bands",
        sensitivity: "confidential",
      });
      await world.document("travel.md", POLICY, { title: "Travel policy" });
      const rerank = vi.spyOn(world.gateway, "rerank");
      await world.retrieval.search({ text: "grade 7 salaries" }, CAROL);
      await world.retrieval.search({ text: "grade 7 salaries" }, BOB);
      expect(rerank.mock.calls.map(([req]) => req.sensitivity)).toEqual(["confidential", "internal"]);

      rerank.mockRejectedValueOnce(
        new GatewayException("no_route", "no rerank model allowed for sensitivity confidential"),
      );
      const fused = await world.retrieval.search({ text: "grade 7 salaries" }, CAROL);
      expect(fused.hits.map((h) => h.title)).toContain("Salary bands");
    });

    test("a contradiction with a value the asker cannot read is not shown to them", async ({ world }) => {
      const policy = await world.document("travel.md", POLICY, { title: "Travel policy" });
      const rule = "Directors' hotels in tier-1 cities cost at most 987654 yuan a night.";
      const board = await world.document("board.md", [{ id: "p1", text: rule }], {
        title: "Board rules",
        readers: [ALICE],
      });
      const held = await world.claim(POLICY[1]?.text as string, policy.spansOf("p1")[0] as never, {
        ...cap(650),
        quote: "Hotels in tier-1 cities cost at most 650 yuan a night.",
      });
      const hidden = await world.claim(rule, board.spansOf("p1")[0] as never, cap(987654));
      world.verdicts.set(HOTEL, {
        tenant_id: TENANT,
        slot_key: HOTEL,
        held_value: "650 CNY/night",
        disputed: true,
        values: [
          { value: "650 CNY/night", standing: "holds", claim_ids: [held.id] },
          { value: "987654 CNY/night", standing: "disputed", claim_ids: [hidden.id] },
        ],
        decided_on: "2026-10-01",
      });
      const question = "How much can a hotel in a tier-1 city cost a night?";

      const bob = await world.retrieval.answer({ question }, BOB);
      expect(bob.answer).toContain("650");
      expect(JSON.stringify(bob)).not.toMatch(new RegExp(`987654|${hidden.id}`));
      const seen = (await world.retrieval.search({ text: question }, BOB)).hits.find((h) => h.unit_id === held.id);
      expect(seen).toMatchObject({ standing: "holds", review_status: "unreviewed" });

      const alice = await world.retrieval.answer({ question }, ALICE);
      expect(alice.notes?.find((n) => n.kind === "conflict")?.text).toContain("987654");
    });

    test("the value that holds joins an answer as the search's filters allow, with its freshness", async ({
      world,
    }) => {
      const text = "Old handbook: hotels in tier-1 cities cost at most 600 yuan a night.";
      const copy = await world.document("copy.md", [{ id: "p1", text }], { title: "Old handbook" });
      const rule = "Hotels cost at most 650 yuan a night.";
      const policy = await world.document("policy.md", [{ id: "p1", text: rule }], { title: "Policy", indexed: false });
      const old = await world.claim(text, copy.spansOf("p1")[0] as never, { ...cap(600), confidence: 0.99 });
      const held = await world.claim(rule, policy.spansOf("p1")[0] as never, { ...cap(650), confidence: 0.9 });
      world.verdicts.set(
        HOTEL,
        verdict({ value: "650 CNY/night", claim: held.id }, { value: "600 CNY/night", claim: old.id }),
      );
      world.staleness.set(held.id, {
        unit_id: held.id,
        score: 0.99,
        state: "stale",
        computed_at: "2026-10-20T00:00:00Z",
      });
      const question = "How much can a hotel in a tier-1 city cost a night?";

      const answer = await world.retrieval.answer({ question }, ALICE);
      expect(answer.used_unit_ids).toContain(held.id);
      expect(answer.freshness?.state).toBe("stale");
      const strict = await world.retrieval.answer({ question, filters: { min_confidence: 0.95 } }, ALICE);
      expect(strict.used_unit_ids ?? []).not.toContain(held.id);
      expect(strict.notes?.some((n) => n.kind === "thin_evidence")).toBeFalsy();
    });

    test("a deleted document leaves the index, and a late older version changes nothing", async ({ world }) => {
      const first = await world.document("travel.md", POLICY, { title: "Travel policy" });
      await world.document("travel.md", [], { title: "Travel policy", deleted: true });
      expect((await world.retrieval.search({ text: "hotel tier-1 cities" }, ALICE)).hits).toEqual([]);
      await world.retrieval.onBlocksChanged(first.event);
      expect((await world.retrieval.search({ text: "hotel tier-1 cities" }, ALICE)).hits).toEqual([]);
      expect(await world.retrieval.documents(TENANT)).toMatchObject([{ deleted: true, chunk_ids: [] }]);
    });

    test("the rivals: plain retrieval reads passages alone, and long context every readable document", async ({
      world,
    }) => {
      const policy = await world.document("travel.md", POLICY, { title: "Travel policy" });
      await world.document("salaries.md", [{ id: "p1", text: "Grade 7 salaries start at 30,000 yuan a month." }], {
        title: "Salary bands",
        sensitivity: "confidential",
      });
      const held = await world.claim(
        "The hotel cap in tier-1 cities is 650 yuan a night.",
        policy.spansOf("p1")[0] as never,
        {
          ...cap(650),
          quote: "Hotels in tier-1 cities cost at most 650 yuan a night.",
        },
      );
      const question = { question: "What is the hotel cap a night in tier-1 cities?" };

      expect((await world.retrieval.sources(question, ALICE)).map((h) => h.unit_id)).toContain(held.id);
      const passages = await world.baseline("passages").sources(question, ALICE);
      expect(passages.length).toBeGreaterThan(0);
      expect(passages.every((h) => h.kind === "chunk")).toBe(true);
      const plain = await world.baseline("passages").answer(question, ALICE);
      expect(plain.answer).toContain("650");
      expect(plain.used_unit_ids).not.toContain(held.id);

      // Every passage of the travel policy, in reading order; the salaries are not Alice's to read.
      const everything = await world.baseline("long_context").sources(question, ALICE);
      expect(everything.map((h) => h.citations[0]?.source_title)).toEqual(everything.map(() => "Travel policy"));
      expect(everything.flatMap((h) => h.citations.map((c) => c.quote))).toEqual(policy.spans.map((s) => s.text));
      expect((await world.baseline("long_context").sources(question, CAROL)).length).toBeGreaterThan(everything.length);
      await expect(world.baseline("long_context", { contextTokens: 5 }).answer(question, ALICE)).rejects.toThrow(
        ContextTooLong,
      );
    });

    describe.each(LANGUAGES)("answers in $tag", ({ cases }) => {
      test("every sentence cites its source, the value that holds answers, and the replaced one gets a note", async ({
        world,
      }) => {
        const { answers: c } = cases;
        const policy = await world.document("policy.md", [{ id: "p1", text: c.policy }], { title: "Policy" });
        const copy = await world.document("copy.md", [{ id: "p1", text: c.copy }], { title: "Copy" });
        const held = await world.claim(c.policy, policy.spansOf("p1")[0] as never, cap(650));
        const old = await world.claim(c.copy, copy.spansOf("p1")[0] as never, cap(600));
        world.verdicts.set(
          HOTEL,
          verdict({ value: "650 CNY/night", claim: held.id }, { value: "600 CNY/night", claim: old.id }),
        );

        const answer = await world.retrieval.answer({ question: c.question }, ALICE);
        expect(answer.answer).toContain("650");
        expect(answer.answer).not.toContain("600");
        expect(answer.answer).toMatch(/\[1\]/);
        expect(answer.citations[0]).toMatchObject({ source_title: "Policy" });
        expect(answer.used_unit_ids).toContain(held.id);
        expect(answer.notes?.find((n) => n.kind === "outdated")?.text).toContain(c.outdated);
        expect(answer.gaps).toEqual([]);
        expect(answer.confidence).toBeGreaterThan(0);

        const none = await world.retrieval.answer({ question: c.unrelated }, ALICE);
        expect(none).toMatchObject({ answer: c.nothing, citations: [], confidence: 0, gaps: [c.unrelated] });
      });

      test("a value held in a document the asker cannot read neither answers nor shows through a mark or a note", async ({
        world,
      }) => {
        const { answers: c } = cases;
        const original = LANGUAGES[0]?.cases.answers as Cases["answers"];
        const policy = await world.document("policy.md", [{ id: "p1", text: original.policy }], {
          title: "Policy",
          readers: [ALICE],
        });
        const copy = await world.document("copy.md", [{ id: "p1", text: c.copy }], { title: "Copy" });
        const held = await world.claim(original.policy, policy.spansOf("p1")[0] as never, cap(650));
        const old = await world.claim(c.copy, copy.spansOf("p1")[0] as never, cap(600));
        world.verdicts.set(
          HOTEL,
          verdict({ value: "650 CNY/night", claim: held.id }, { value: "600 CNY/night", claim: old.id }),
        );

        const hits = (await world.retrieval.search({ text: c.question }, BOB)).hits;
        const found = hits.find((h) => h.unit_id === old.id);
        expect(found).toBeDefined();
        expect(found?.standing).toBeUndefined();
        expect(found?.held_unit_id).toBeUndefined();
        const answer = await world.retrieval.answer({ question: c.question }, BOB);
        expect(JSON.stringify(answer)).not.toMatch(new RegExp(`650|${held.id}`));
        expect(answer.notes).toBeUndefined();
        expect((await world.retrieval.answer({ question: c.question }, ALICE)).answer).toContain("650");
      });

      test("a translation behind its original answers with the original's value", async ({ world }) => {
        const { answers: c } = cases;
        const original = LANGUAGES[0]?.cases.answers as Cases["answers"];
        const policy = await world.document("policy.md", [{ id: "p1", text: original.policy }], { title: "Policy" });
        const copy = await world.document("copy.md", [{ id: "p1", text: c.copy }], { title: "Copy" });
        const held = await world.claim(original.policy, policy.spansOf("p1")[0] as never, cap(650));
        const old = await world.claim(c.copy, copy.spansOf("p1")[0] as never, cap(600));
        world.verdicts.set(
          HOTEL,
          verdict({ value: "650 CNY/night", claim: held.id }, { value: "600 CNY/night", claim: old.id }),
        );

        // The copy's sentence is left out of its passage; its statement brings the original's.
        const answer = await world.retrieval.answer({ question: c.question }, ALICE);
        expect(answer.answer).toContain("650");
        expect(answer.answer).not.toContain("600");
        expect(answer.citations.map((x) => x.source_title)).toEqual(["Policy"]);
        expect(answer.notes?.find((n) => n.kind === "outdated")?.text).toContain(c.outdated);
      });
    });
  });
});
