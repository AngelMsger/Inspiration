// Retrieval against the in-memory doubles and Postgres (pgvector, pg_search).

import { GatewayException, type SlotVerdict } from "@inspiration/contracts";
import { languageOf } from "@inspiration/kernel";
import { testData } from "@inspiration/testkit";
import { describe, expect, vi } from "vitest";
import {
  ANSWER_SOURCES,
  ANSWER_TASK,
  type AnswerInput,
  ContextTooLong,
  chunk,
  inputOf,
  MATURE_SOURCES,
  MAX_TOKENS,
  TRANSLATE_TASK,
  type TranslateInput,
} from "../src/index.ts";
import { ALICE, BACKENDS, BOB, CAROL, cap, EMPTY_SPACE, HOTEL, retrievalTest, SPACE, TENANT } from "./fixtures.ts";

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
      expect(JSON.stringify(bob)).not.toMatch(new RegExp(`\\b987654\\b|${hidden.id}`));
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

    test("the rivals: a mature retrieval reads passages alone, and long context every readable document", async ({
      world,
    }) => {
      const policy = await world.document("travel.md", POLICY, {
        title: "Travel policy",
        modified: "2026-09-13T08:00:00Z",
      });
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
      const passages = await world.baseline("mature").sources(question, ALICE);
      expect(passages.length).toBeGreaterThan(0);
      expect(passages.every((h) => h.kind === "chunk")).toBe(true);
      const complete = vi.spyOn(world.gateway, "complete");
      const mature = await world.baseline("mature").answer(question, ALICE);
      expect(mature.answer).toContain("650");
      expect(mature.used_unit_ids).not.toContain(held.id);
      // Each passage names its document's level and the day it last changed, to weigh sources that disagree.
      const asked = complete.mock.calls.find(([req]) => req.task === ANSWER_TASK)?.[0];
      const input = inputOf<AnswerInput>(asked?.messages.map((m) => m.content).join("\n") ?? "");
      expect(input?.sources[0]).toMatchObject({ kind: "passage", level: "governed", changed: "2026-09-13" });

      // Every passage of the travel policy, in reading order; the salaries are not Alice's to read.
      const everything = await world.baseline("long_context").sources(question, ALICE);
      expect(everything.map((h) => h.citations[0]?.source_title)).toEqual(everything.map(() => "Travel policy"));
      expect(everything.flatMap((h) => h.citations.map((c) => c.quote))).toEqual(policy.spans.map((s) => s.text));
      expect((await world.baseline("long_context").sources(question, CAROL)).length).toBeGreaterThan(everything.length);
      await expect(world.baseline("long_context", { contextTokens: 5 }).answer(question, ALICE)).rejects.toThrow(
        ContextTooLong,
      );

      // Both baselines read only the spaces asked for: here one Alice reads with nothing in it.
      for (const kind of ["mature", "long_context"] as const) {
        const scoped = (space: string) => world.baseline(kind).sources({ ...question, space_ids: [space] }, ALICE);
        expect(await scoped(EMPTY_SPACE), kind).toEqual([]);
        expect((await scoped(SPACE)).length, kind).toBeGreaterThan(0);
      }
      const filtered = { ...question, space_ids: [SPACE], filters: { min_confidence: 0.99 } };
      const ids = (hits: { unit_id: string }[]) => hits.map((h) => h.unit_id);
      expect(ids(await world.baseline("long_context").sources(filtered, ALICE))).toEqual(ids(everything));
      await expect(
        world.baseline("long_context", { contextTokens: 5 }).answer({ ...question, space_ids: [EMPTY_SPACE] }, ALICE),
      ).resolves.toMatchObject({ citations: [], confidence: 0 });
    });

    test("the mature rival reads more passages than the knowledge base, which reads statements beside them", async ({
      world,
    }) => {
      for (let i = 0; i < 24; i++) {
        await world.document(`notes/${i}.md`, [{ id: "p1", text: `Note ${i} on hotels in tier-1 cities.` }]);
      }
      const question = { question: "What do the notes say about hotels in tier-1 cities?" };
      expect(await world.baseline("mature").sources(question, ALICE)).toHaveLength(MATURE_SOURCES);
      const own = await world.retrieval.sources(question, ALICE);
      expect(own.filter((h) => h.kind === "chunk")).toHaveLength(ANSWER_SOURCES);
    });

    test("a question that cannot be translated is searched alone, and counted", async ({ world }) => {
      await world.document("travel.md", POLICY, { title: "Travel policy" });
      const question = "What is the hotel cap a night in tier-1 cities?";
      const complete = vi.spyOn(world.gateway, "complete");
      const before = world.retrieval.totals.untranslated;
      // A call that fails, and a reply that is no valid translation.
      for (const code of ["provider_error", "invalid_output"] as const) {
        complete.mockRejectedValueOnce(new GatewayException(code, "no translation"));
        const { hits } = await world.retrieval.search({ text: question, kinds: ["chunk"] }, ALICE);
        expect(hits[0]?.snippet, code).toContain("650 yuan");
      }
      expect(world.retrieval.totals.untranslated).toBe(before + 2);
    });

    test("governed long context reads every latest edition, without what no longer holds, the value that holds beside it", async ({
      world,
    }) => {
      const before = await world.document("travel-2024.md", POLICY, {
        title: "Travel policy",
        modified: "2024-02-08T00:00:00Z",
      });
      const policy = await world.document("travel.md", POLICY, {
        title: "Travel policy",
        modified: "2026-09-13T00:00:00Z",
        editions: [before],
      });
      const handbook = await world.document(
        "handbook.md",
        [{ id: "p1", text: "Hotels in tier-1 cities cost at most 600 yuan a night." }],
        { title: "Old handbook", level: "reference", authority: 0.5 },
      );
      const held = await world.claim(
        "Hotels in tier-1 cities cost at most 650 yuan a night.",
        policy.spansOf("p1")[0] as never,
        { ...cap(650), quote: "Hotels in tier-1 cities cost at most 650 yuan a night." },
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
      const question = { question: "What is the hotel cap a night in tier-1 cities?" };
      const all = world.knowledgeBase({ readAll: true });

      const hits = await all.sources(question, ALICE);
      const versions = new Set(hits.flatMap((h) => h.citations.map((c) => c.source_version_id)));
      // The replaced edition and the handbook's only, outdated sentence are left out.
      expect(versions.has(before.version.id)).toBe(false);
      const passages = hits.filter((h) => h.kind === "chunk");
      expect(passages.flatMap((h) => h.citations.map((c) => c.quote))).toEqual(policy.spans.map((s) => s.text));
      // The outdated value is marked, with the value that holds beside it.
      expect(hits.filter((h) => h.kind === "claim").map((h) => [h.unit_id, h.standing])).toEqual([
        [old.id, "outdated"],
        [held.id, "holds"],
      ]);
      expect((await all.answer(question, ALICE)).answer).toContain("650");
      await expect(world.knowledgeBase({ readAll: true, contextTokens: 5 }).answer(question, ALICE)).rejects.toThrow(
        ContextTooLong,
      );
    });

    test("an answer reads the latest edition the asker can read, and an older one is left out", async ({ world }) => {
      const maglev = (opening: string) => [
        { id: "h1", text: "Maglev", heading: true },
        { id: "p1", text: `The maglev line from Tokyo to Nagoya is to open ${opening}.` },
        { id: "p2", text: "Its trains are to run at 505 km/h." },
      ];
      const asOf = (day: string) => ({ title: "Maglev", level: "reference" as const, authority: 0.5, modified: day });
      const old = await world.document("research/maglev-2024.md", maglev("in 2027"), asOf("2024-10-23T02:31:09Z"));
      const said = await world.claim(
        "The maglev line from Tokyo to Nagoya is to open in 2027.",
        old.spansOf("p1")[0] as never,
      );
      const current = await world.document("research/maglev.md", maglev("in 2034 at the earliest"), {
        ...asOf("2026-10-12T04:05:32Z"),
        readers: [ALICE],
        editions: [old],
      });
      const question = { question: "When is the maglev line from Tokyo to Nagoya to open?" };

      const answer = await world.retrieval.answer(question, ALICE);
      expect(answer.answer).toContain("2034");
      expect(answer.answer).not.toContain("2027");
      expect(answer.used_unit_ids).not.toContain(said.id);
      expect(new Set(answer.citations.map((c) => c.source_version_id))).toEqual(new Set([current.version.id]));
      // A rival knows nothing of editions.
      const plain = await world.baseline("mature").sources(question, ALICE);
      expect(plain.flatMap((h) => h.citations.map((c) => c.source_version_id))).toContain(old.version.id);
      // Bob cannot read the latest edition, so for him the older one is the latest he has.
      expect((await world.retrieval.answer(question, BOB)).answer).toContain("2027");

      // A newer draft in a less trusted place replaces nothing, and a deleted edition nothing either.
      const draft = await world.document("drafts/maglev.md", maglev("in 2040"), {
        ...asOf("2026-10-20T00:00:00Z"),
        authority: 0.3,
        editions: [current, old],
      });
      expect(
        (await world.retrieval.sources(question, ALICE)).flatMap((h) => h.citations.map((c) => c.source_version_id)),
      ).toEqual(expect.arrayContaining([current.version.id, draft.version.id]));
      await world.document("research/maglev.md", [], { ...asOf("2026-10-25T00:00:00Z"), deleted: true });
      expect((await world.retrieval.answer(question, ALICE)).answer).toContain("2027");
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
        expect(JSON.stringify(answer)).not.toMatch(new RegExp(`\\b650\\b|${held.id}`));
        expect(answer.notes).toBeUndefined();
        expect((await world.retrieval.answer({ question: c.question }, ALICE)).answer).toContain("650");
      });

      test("a question finds documents in another language through its translations", async ({ world }) => {
        const { answers: c } = cases;
        const original = LANGUAGES[0]?.cases.answers as Cases["answers"];
        await world.document("policy.md", [{ id: "p1", text: original.policy }], { title: "Policy" });
        for (let i = 0; i < 12; i++) {
          await world.document(`notes/${i}.md`, [{ id: "p1", text: `Note ${i} on the office plants.` }]);
        }
        const complete = vi.spyOn(world.gateway, "complete");
        complete.mockImplementation(async (req) => {
          const input = inputOf<TranslateInput>(req.messages.map((m) => m.content).join("\n"));
          const translations = (input?.languages ?? []).map((language) => ({
            language,
            text: LANGUAGES.find((l) => l.tag === language)?.cases.answers.question ?? "",
          }));
          return {
            request_id: "req_01JC000000000000000000000001",
            text: JSON.stringify({ translations }),
            json: { translations },
            provider: "fake",
            model: "fake-chat",
            finish_reason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
            cost: { amount: 0, currency: "USD" },
            cached: false,
            latency_ms: 1,
          };
        });
        const { hits } = await world.retrieval.search({ text: c.question, kinds: ["chunk"] }, ALICE);
        expect(hits[0]?.title).toBe("Policy");
        const asked = complete.mock.calls.find(([req]) => req.task === TRANSLATE_TASK)?.[0];
        const input = inputOf<TranslateInput>(asked?.messages.map((m) => m.content).join("\n") ?? "");
        expect(input?.languages).toEqual(
          LANGUAGES.map((l) => l.tag)
            .filter((t) => t !== languageOf(c.question))
            .sort(),
        );
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
