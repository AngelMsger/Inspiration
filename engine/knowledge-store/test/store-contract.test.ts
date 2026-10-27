// KnowledgeStore contract tests. Every test runs against MemoryStore and PostgresStore.

import {
  type AclSnapshot,
  type ClaimDerivation,
  type ClaimsData,
  contentHash,
  type DataColumn,
  newEvent,
  type StoreTx,
  stableId,
} from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { type BaseStore, IntegrityError } from "../src/index.ts";
import type { Sample } from "../src/testing.ts";
import { BACKENDS, storeTest } from "./fixtures.ts";

const POLICY = [
  "Article 3 Hotel standards: tier-1 cities at most 600 yuan a night, other cities at most 450 yuan a night.",
  "Article 4 Hotels above the standard need the department head's approval.",
];
const DAY = 86_400_000;

async function seed(store: BaseStore, kb: Sample, texts: string[] = POLICY) {
  const [sv, spans] = kb.sourceVersion(texts);
  await store.transaction((tx) => tx.putSourceVersion(sv, spans));
  return [sv, spans] as const;
}

/** A transaction that must fail, and the error it failed with. */
function failing(store: BaseStore, fn: (tx: StoreTx) => Promise<unknown>): Promise<unknown> {
  return store.transaction(fn).then(
    () => expect.unreachable("the transaction committed"),
    (e: unknown) => e,
  );
}

async function rejects(store: BaseStore, fn: (tx: StoreTx) => Promise<unknown>, message: RegExp): Promise<void> {
  const e = await failing(store, fn);
  expect(e).toBeInstanceOf(IntegrityError);
  expect((e as Error).message).toMatch(message);
}

const COLUMNS: [DataColumn, DataColumn, DataColumn] = [
  { field: "subject", field_type: "nominal" },
  { field: "value_number", field_type: "quantitative", unit: "CNY/night" },
  { field: "valid_from", field_type: "temporal" },
];

describe.each(BACKENDS)("$backend store", ({ backend, skip }) => {
  const test = storeTest(backend);

  describe.skipIf(skip)("sources and spans", () => {
    test("source versions are immutable and spans ordered", async ({ store, kb }) => {
      const [sv, spans] = await seed(store, kb);
      expect(await store.getSourceVersion(sv.id)).toEqual(sv);
      expect((await store.spansOf(sv.id)).map((s) => s.id)).toEqual(spans.map((s) => s.id));
      expect(await store.getSpans([spans[1]?.id ?? "", "spn_01JC00000000000000MISSING"])).toEqual([spans[1]]);

      // Same ID: kept as first written.
      await store.transaction((tx) => tx.putSourceVersion({ ...sv, title: "changed" }, spans));
      expect((await store.getSourceVersion(sv.id))?.title).toBe(sv.title);
    });

    test("blocks give a version its structure and share unchanged spans", async ({ store, kb }) => {
      const [v1, [s1, s2]] = kb.sourceVersion(POLICY);
      const b1 = kb.block(v1, [s1]);
      const b2 = kb.block(v1, [s2 as typeof s1]);
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(v1);
        await tx.putBlocks(
          v1.id,
          [b2, b1],
          [
            { ...s1, block_id: b1.id },
            { ...(s2 as typeof s1), block_id: b2.id },
          ],
        );
      });
      // The second version keeps the first passage and rewrites the second.
      const [v2, [s3]] = kb.sourceVersion(["Article 4 Hotels above the standard need the vice president's approval."]);
      const b1v2 = { ...kb.block(v2, [s1]), id: b1.id };
      const b2v2 = { ...kb.block(v2, [s3], { ordinal: 1 }), id: b2.id };
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(v2);
        await tx.putBlocks(v2.id, [b1v2, b2v2], [{ ...s3, block_id: b2.id }]);
      });
      expect((await store.spansOf(v1.id)).map((s) => s.text)).toEqual(POLICY);
      expect((await store.spansOf(v2.id)).map((s) => s.id)).toEqual([s1.id, s3.id]);
      expect((await store.getSpans([s1.id]))[0]?.source_version_id).toBe(v1.id);
      expect((await store.blocksOf(v1.id)).map((b) => b.id)).toEqual([b1.id, b2.id]);
      expect(await store.blocksOf(v2.id)).toEqual([b1v2, b2v2]);

      // Blocks are written once per version.
      await store.transaction((tx) => tx.putBlocks(v2.id, [b1v2], []));
      expect(await store.blocksOf(v2.id)).toHaveLength(2);
    });

    test("block writes are checked", async ({ store, kb }) => {
      const [v1, [s1]] = kb.sourceVersion(POLICY);
      await store.transaction((tx) => tx.putSourceVersion(v1));
      const block = kb.block(v1, [s1]);
      await rejects(store, (tx) => tx.putBlocks("sv_01JC000000000000000UNKNOWN", [], []), /unknown source version/);
      await rejects(store, (tx) => tx.putBlocks(v1.id, [block], []), /lists unknown spans/);
      await rejects(store, (tx) => tx.putBlocks(v1.id, [block, block], [s1]), /appears twice/);
      await rejects(
        store,
        (tx) => tx.putBlocks(v1.id, [{ ...block, text: "changed" }], [s1]),
        /text_hash does not match/,
      );
      await rejects(
        store,
        (tx) => tx.putBlocks(v1.id, [block], [{ ...s1, block_id: "blk_01JC000000000000000UNKNOWN" }]),
        /not in sv_/,
      );
      const [other] = kb.sourceVersion(POLICY);
      await rejects(store, (tx) => tx.putBlocks(v1.id, [kb.block(other, [])], []), /belongs to/);
      expect(await store.blocksOf(v1.id)).toEqual([]);
    });

    test("the latest source version follows fetch time", async ({ store, kb }) => {
      const [v1] = await seed(store, kb);
      const [v2, spans2] = kb.sourceVersion(["Article 3 Hotel standards: tier-1 cities at most 650 yuan a night."]);
      await store.transaction((tx) => tx.putSourceVersion(v2, spans2));
      const latest = await store.latestSourceVersion(kb.sourceId, "doc-1");
      expect(latest?.id).toBe(v2.id);
      expect(latest?.id).not.toBe(v1.id);
      expect(await store.latestSourceVersion(kb.sourceId, "doc-404")).toBeUndefined();
    });

    test("spans must match their version", async ({ store, kb }) => {
      const [sv, spans] = kb.sourceVersion(POLICY);
      const [other] = kb.sourceVersion(["x"]);
      await rejects(store, (tx) => tx.putSourceVersion(other, spans), /belongs to/);
      await rejects(store, (tx) => tx.putSourceVersion(sv, [{ ...spans[0], text: "tampered" }]), /text_hash/);
    });
  });

  describe.skipIf(skip)("chunks", () => {
    test("chunks round-trip and are removed", async ({ store, kb }) => {
      const [sv, spans] = await seed(store, kb);
      const chunks = spans.map((s, i) => kb.chunk(sv, [s], { ordinal: i }));
      const [first, second] = chunks as [(typeof chunks)[0], (typeof chunks)[0]];
      await store.transaction((tx) =>
        tx.putChunks(chunks, { [first.id]: [0.1, 0.2, 0.3] }, { model: "fake-embedding" }),
      );
      expect((await store.chunksOf(sv.id)).map((c) => c.id)).toEqual(chunks.map((c) => c.id));
      expect(await store.getChunks([second.id])).toEqual([second]);

      const updated = { ...first, contextual_header: "Hotel standards in the travel policy" };
      await store.transaction(async (tx) => {
        await tx.putChunks([updated]);
        await tx.removeChunks([second.id]);
      });
      expect(await store.chunksOf(sv.id)).toEqual([updated]);

      // An unchanged chunk carried into the document's next version moves with it.
      const [next] = kb.sourceVersion(POLICY, { previous_version_id: sv.id });
      await store.transaction((tx) => tx.putSourceVersion(next));
      const moved = { ...updated, source_version_id: next.id };
      await store.transaction((tx) => tx.putChunks([moved]));
      expect(await store.chunksOf(sv.id)).toEqual([]);
      expect(await store.chunksOf(next.id)).toEqual([moved]);
    });

    test("chunk writes are checked", async ({ store, kb }) => {
      const [sv, spans] = await seed(store, kb);
      const chunk = kb.chunk(sv, [spans[0]]);
      await rejects(store, (tx) => tx.putChunks([chunk], { [chunk.id]: [1] }), /model/);
      await rejects(
        store,
        (tx) => tx.putChunks([chunk], { chk_01JC0000000000000000OTHER: [1] }, { model: "m" }),
        /not in this write/,
      );
      const [orphan, orphanSpans] = kb.sourceVersion(["never stored"]);
      await rejects(store, (tx) => tx.putChunks([kb.chunk(orphan, orphanSpans)]), /unknown source version/);
    });
  });

  describe.skipIf(skip)("claims and evidence", () => {
    test("claims need evidence that quotes the span", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [claim, evidence] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
      });
      expect(await store.transaction((tx) => tx.upsertClaims([claim], evidence))).toEqual([claim.id]);
      expect(await store.getClaims([claim.id])).toEqual([claim]);
      expect(await store.evidenceOf([claim.id])).toEqual(evidence);
      expect(await store.claimsCiting([spans[0].id])).toEqual([claim.id]);
      expect(await store.claimsCiting([spans[1]?.id ?? ""])).toEqual([]);

      const [lonely] = kb.claim("A statement without evidence");
      await rejects(store, (tx) => tx.upsertClaims([lonely], []), /no supporting evidence/);

      const [invented, [ev]] = kb.claim("Tier-1 cities: 700 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
      });
      if (!ev) throw new Error("no evidence");
      await rejects(
        store,
        (tx) => tx.upsertClaims([invented], [{ ...ev, quote: "at most 700 yuan a night" }]),
        /quote is not in span/,
      );
      await rejects(store, (tx) => tx.upsertClaims([invented], [{ ...ev, quote_start: 0 }]), /offsets/);
      expect(await store.getClaims([lonely.id, invented.id])).toEqual([]);
    });

    test("evidence named twice in one write is kept once, the last", async ({ store, kb }) => {
      // A model may quote one span twice for one claim; evidence is one row per claim, span and role.
      const [, spans] = await seed(store, kb);
      const [claim, [first]] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
      });
      const [, [second]] = kb.claim("The same cap", spans[0], { quote: "600 yuan a night" });
      if (!first || !second) throw new Error("no evidence");
      const again = { ...second, claim_id: claim.id };
      await store.transaction((tx) => tx.upsertClaims([claim], [first, again]));
      expect(await store.evidenceOf([claim.id])).toEqual([again]);
    });

    test("contradicting evidence alone does not support a claim", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [claim, [ev]] = kb.claim("Tier-1 cities: 700 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
      });
      if (!ev) throw new Error("no evidence");
      await rejects(
        store,
        (tx) => tx.upsertClaims([claim], [{ ...ev, role: "contradicts" }]),
        /no supporting evidence/,
      );
    });

    test("updating a stored claim keeps its support", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [claim, evidence] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0]);
      await store.transaction((tx) => tx.upsertClaims([claim], evidence));
      await store.transaction((tx) => tx.upsertClaims([{ ...claim, status: "verified", weight: 2 }], []));
      expect((await store.getClaims([claim.id]))[0]?.status).toBe("verified");
    });

    test("derived claims need known inputs", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [a, ea] = kb.claim("tier-1 cities at most 600 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
      });
      const [b, eb] = kb.claim("other cities at most 450 yuan a night", spans[0], {
        quote: "other cities at most 450 yuan a night",
      });
      const [merged] = kb.claim("Hotel caps come in two tiers by city: 600 and 450 yuan", undefined, {
        origin: "merged",
      });
      const derivation: ClaimDerivation = { claim_id: merged.id, from_claim_ids: [a.id, b.id], method: "merge" };
      await store.transaction((tx) => tx.upsertClaims([a, b, merged], [...ea, ...eb], [derivation]));
      const graph = await store.lineage(merged.id);
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          { from_id: merged.id, to_id: a.id, relation: "derived_from" },
          { from_id: merged.id, to_id: b.id, relation: "derived_from" },
          { from_id: a.id, to_id: ea[0]?.span_id, relation: "cites", role: "supports" },
        ]),
      );

      const [ghost] = kb.claim("An inference from nothing");
      const bad: ClaimDerivation = {
        claim_id: ghost.id,
        from_claim_ids: ["clm_01JC00000000000000000GHOST"],
        method: "infer",
      };
      await rejects(store, (tx) => tx.upsertClaims([ghost], [], [bad]), /unknown claims/);
    });

    test("supersede, and bitemporal reads", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const jan = kb.now;
      const feb = new Date(jan.getTime() + 31 * DAY);
      const [old, evOld] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
        predicate: "hotel_cap_per_night",
        valid_time: { start: jan.toISOString(), end: feb.toISOString() },
        value: { kind: "money", number: 600, unit: "CNY/night", currency: "CNY" },
      });
      await store.transaction((tx) => tx.upsertClaims([old], evOld));
      const believedBefore = kb.tick();
      const [next, evNext] = kb.claim("The tier-1 city hotel cap is 650 yuan a night", spans[0], {
        quote: "Article 3 Hotel standards",
        predicate: "hotel_cap_per_night",
        valid_time: { start: feb.toISOString() },
      });
      await store.transaction(async (tx) => {
        await tx.upsertClaims([next], evNext);
        kb.tick();
        await tx.supersede(old.id, next.id, "policy revised in February");
      });

      const ids = async (options: { validAt?: Date; knownAt?: Date }, predicates?: string[]) =>
        (await store.asOf(predicates ? { predicates } : {}, options)).map((c) => c.id);
      expect(await ids({}, ["hotel_cap_per_night"])).toEqual([next.id]);
      expect(await ids({ knownAt: believedBefore }, ["hotel_cap_per_night"])).toEqual([old.id]);
      const [stored] = await store.getClaims([old.id]);
      expect(stored).toMatchObject({ status: "superseded", superseded_by: next.id });

      // validAt picks what was true in the world at that time, among current beliefs.
      expect(await ids({ validAt: new Date(jan.getTime() + DAY) })).toEqual([]);
      expect(await ids({ validAt: new Date(feb.getTime() + 30 * DAY) })).toEqual([next.id]);

      await rejects(store, (tx) => tx.supersede(old.id, next.id, "again"), /already superseded/);
      await rejects(store, (tx) => tx.supersede("clm_01JC000000000000000NOSUCH", next.id, "x"), /unknown claim/);
    });

    test("a fact slot reads its variants and versions", async ({ store, kb }) => {
      const SLOT = "hotel_cap_per_night|tier-1 city";
      const cap = (n: number, weight: number, start?: string) => ({
        predicate: "hotel_cap_per_night",
        qualifiers: ["tier-1 city"],
        slot_key: SLOT,
        value: { kind: "money" as const, number: n, unit: "CNY/night", normalized: `${n} CNY/night` },
        weight,
        ...(start && { valid_time: { start } }),
      });
      const [, archive] = await seed(store, kb, ["Tier-1 cities at most 500 yuan a night."]);
      const [, policy] = await seed(store, kb, ["Tier-1 cities at most 600 yuan a night."]);
      const [, guide] = await seed(store, kb, ["Hotels in Beijing within 600 yuan a night."]);
      const [, notice] = await seed(store, kb, ["From 1 October, tier-1 cities at most 650 yuan a night."]);
      const [old, evOld] = kb.claim("The tier-1 city hotel cap is 500 yuan a night", archive[0], cap(500, 0.3));
      await store.transaction((tx) => tx.upsertClaims([old], evOld));
      const [p600, evP] = kb.claim(
        "The tier-1 city hotel cap is 600 yuan a night",
        policy[0],
        cap(600, 0.9, "2026-01-01T00:00:00Z"),
      );
      // A claim without its own slot key is in the slot its predicate and qualifiers make.
      const { slot_key: _key, ...unkeyed } = cap(600, 0.5);
      const [g600, evG] = kb.claim("The Beijing hotel cap is 600 yuan a night", guide[0], unkeyed);
      const [n650, evN] = kb.claim(
        "The tier-1 city hotel cap is 650 yuan a night",
        notice[0],
        cap(650, 0.5, "2026-10-01T00:00:00Z"),
      );
      const [other, evO] = kb.claim("Hotels above the cap need approval", policy[0], {
        predicate: "approval_needed",
        slot_key: "approval_needed",
      });
      await store.transaction(async (tx) => {
        await tx.upsertClaims([p600, g600, n650, other], [...evP, ...evG, ...evN, ...evO]);
        kb.tick();
        await tx.supersede(old.id, p600.id, "the 2026 policy");
      });
      const [closed] = await store.getClaims([old.id]);

      const slot = await store.slot(kb.tenantId, SLOT);
      expect(slot).toEqual({
        tenant_id: kb.tenantId,
        slot_key: SLOT,
        predicate: "hotel_cap_per_night",
        qualifiers: ["tier-1 city"],
        variants: [
          {
            value: "600 CNY/night",
            claim_count: 2,
            source_version_count: 2,
            claim_ids: [p600.id, g600.id],
            source_version_ids: [policy[0]?.source_version_id, guide[0]?.source_version_id],
            valid_from: "2026-01-01T00:00:00Z",
          },
          {
            value: "650 CNY/night",
            claim_count: 1,
            source_version_count: 1,
            claim_ids: [n650.id],
            source_version_ids: [notice[0]?.source_version_id],
            valid_from: "2026-10-01T00:00:00Z",
          },
        ],
        versions: [
          { value: "500 CNY/night", claim_count: 1, known_from: old.recorded_at, known_to: closed?.superseded_at },
          {
            value: "600 CNY/night",
            claim_count: 2,
            known_from: p600.recorded_at,
            valid_from: "2026-01-01T00:00:00Z",
          },
          { value: "650 CNY/night", claim_count: 1, known_from: n650.recorded_at, valid_from: "2026-10-01T00:00:00Z" },
        ],
      });
      expect(await store.slot(kb.tenantId, "annual_leave_days")).toBeUndefined();
      expect(await store.slot("ten_01JC0000000000000000OTHER", SLOT)).toBeUndefined();
    });

    test("topics form a tree in one space, and placements put claims in them", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [cap, evCap] = kb.claim("tier-1 cities at most 600 yuan a night", spans[0]);
      const [approval, evApproval] = kb.claim(
        "Hotels above the standard need the department head's approval",
        spans[1],
      );
      await store.transaction((tx) => tx.upsertClaims([cap, approval], [...evCap, ...evApproval]));
      const area = kb.topic("t-travel", { title: "Travel" });
      const lodging = kb.topic("t-lodging", { parent_key: "t-travel", title: "Hotel standards", ordinal: 1 });
      // A child may come before its parent in one write.
      await store.transaction((tx) => tx.putTopics([lodging, area]));
      await store.transaction((tx) =>
        tx.place([kb.placement(cap, "t-lodging", { score: 0.82 }), kb.placement(approval, "t-lodging")]),
      );
      expect(await store.topics(kb.tenantId)).toEqual([lodging, area]);
      // A third level, written on its own, is checked against the stored chain.
      const firstTier = kb.topic("t-lodging-tier1", { parent_key: "t-lodging", title: "Tier-1 cities" });
      await store.transaction((tx) => tx.putTopics([firstTier]));
      await rejects(store, (tx) => tx.putTopics([{ ...area, parent_key: "t-lodging-tier1" }]), /own ancestor/);
      expect(await store.topics(kb.tenantId, "spc_01JC0000000000000000OTHER")).toEqual([]);
      expect((await store.placementsIn(kb.tenantId, "t-lodging")).map((p) => p.claim_id)).toEqual(
        [cap.id, approval.id].sort(),
      );
      expect(await store.placementsIn(kb.tenantId, "t-travel")).toEqual([]);

      // Moving a claim replaces its placement; unplacing makes it unfiled.
      const confirmed = kb.placement(approval, "t-travel", {
        placed_by: "member",
        member_id: "mem_01JC0000000000000000000001",
        confirmed: true,
      });
      await store.transaction(async (tx) => {
        await tx.place([confirmed]);
        await tx.unplace([cap.id]);
        await tx.putTopics([{ ...lodging, status: "retired", statement_count: 0 }]);
      });
      expect(await store.placementsOf([cap.id, approval.id])).toEqual([confirmed]);
      expect((await store.topics(kb.tenantId)).map((t) => [t.key, t.status])).toEqual([
        ["t-lodging", "retired"],
        ["t-lodging-tier1", "proposed"],
        ["t-travel", "proposed"],
      ]);

      await rejects(store, (tx) => tx.putTopics([kb.topic("t-orphan", { parent_key: "t-none" })]), /no parent/);
      await rejects(
        store,
        (tx) =>
          tx.putTopics([kb.topic("t-elsewhere", { parent_key: "t-travel", space_id: "spc_01JC0000000000000OTHER" })]),
        /its parent t-travel/,
      );
      await rejects(store, (tx) => tx.place([kb.placement(cap, "t-none")]), /unknown topic/);
      await rejects(
        store,
        (tx) => tx.place([{ ...kb.placement(cap, "t-lodging"), claim_id: "clm_01JC000000000000000NOSUCH" }]),
        /unknown claim/,
      );
    });

    test("claim queries filter", async ({ store, kb }) => {
      const [sv, spans] = await seed(store, kb);
      const [otherSv, otherSpans] = await seed(store, kb, ["Article 1 This policy applies to every employee."]);
      const [a, ea] = kb.claim("tier-1 cities at most 600 yuan a night", spans[0], { knowledge_class: "pricing" });
      const [b, eb] = kb.claim("Hotels above the cap need approval", spans[1], { status: "proposed" });
      const [c, ec] = kb.claim("Applies to every employee", otherSpans[0], {
        space_id: "spc_01JC0000000000000000OTHER",
      });
      await store.transaction((tx) => tx.upsertClaims([a, b, c], [...ea, ...eb, ...ec]));

      const ids = async (q: Parameters<BaseStore["asOf"]>[0]) => (await store.asOf(q)).map((x) => x.id);
      expect(await ids({})).toEqual([a.id, b.id, c.id]);
      expect(await ids({ ids: [b.id] })).toEqual([b.id]);
      expect(await ids({ space_ids: [kb.spaceId] })).toEqual([a.id, b.id]);
      expect(await ids({ statuses: ["proposed"] })).toEqual([b.id]);
      expect(await ids({ knowledge_classes: ["pricing"] })).toEqual([a.id]);
      expect(await ids({ source_version_ids: [otherSv.id] })).toEqual([c.id]);
      expect(await ids({ source_version_ids: [sv.id], statuses: ["active"] })).toEqual([a.id]);
      expect(await ids({ limit: 2 })).toEqual([a.id, b.id]);
    });
  });

  describe.skipIf(skip)("dependencies, pages and lineage", () => {
    test("dependencies are replaced per artifact", async ({ store }) => {
      const page = "pg_01JC00000000000000000PAGE1";
      const sop = "sop_01JC0000000000000000000SOP1";
      const [c1, c2] = ["clm_01JC0000000000000000000CL1", "clm_01JC0000000000000000000CL2"];
      const h = `sha256:${"0".repeat(64)}`;
      await store.transaction((tx) =>
        tx.recordDependencies([
          { artifact_id: page, input_id: c1, input_hash: h },
          { artifact_id: sop, input_id: c1, input_hash: h },
        ]),
      );
      expect(await store.dependents([c1])).toEqual([page, sop]);
      await store.transaction((tx) => tx.recordDependencies([{ artifact_id: page, input_id: c2, input_hash: h }]));
      expect(await store.dependents([c1])).toEqual([sop]);
      expect(await store.dependents([c2])).toEqual([page]);
    });

    test("page snapshots are versioned", async ({ store, kb }) => {
      const pageId = stableId("page", "travel", "hotel");
      await store.transaction((tx) => tx.putPageSnapshot(kb.page(pageId, 1)));
      await store.transaction((tx) =>
        tx.putPageSnapshot(kb.page(pageId, 2, [], { change_summary: "Hotel cap raised to 650" })),
      );
      await rejects(store, (tx) => tx.putPageSnapshot(kb.page(pageId, 5)), /next version is 3/);
      await rejects(store, (tx) => tx.putPageSnapshot(kb.page(pageId, 2)), /next version is 3/);

      const latest = await store.getPage(pageId);
      expect(latest?.version).toBe(2);
      expect((await store.getPage(pageId, 1))?.spec.version).toBe(1);
      expect(await store.getPage(pageId, 9)).toBeUndefined();
      const history = await store.pageHistory(pageId);
      expect(history.map((h) => [h.version, h.change_summary])).toEqual([
        [1, undefined],
        [2, "Hotel cap raised to 650"],
      ]);
      expect(history[1]?.inputs_hash).toBe(latest?.spec.inputs_hash);
      expect(history[0]).toEqual({
        page_id: pageId,
        version: 1,
        inputs_hash: contentHash(`${pageId}@1`),
        cause: { kind: "initial" },
        created_at: expect.any(String),
      });
    });

    test("lineage runs from a page to the source", async ({ store, kb }) => {
      const [sv, spans] = await seed(store, kb);
      const [claim, evidence] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0]);
      const pageId = stableId("page", "travel", "hotel");
      await store.transaction(async (tx) => {
        await tx.upsertClaims([claim], evidence);
        await tx.putPageSnapshot(kb.page(pageId, 1, [claim.id]));
        await tx.recordDependencies([{ artifact_id: pageId, input_id: claim.id, input_hash: claim.inputs_hash }]);
      });

      const graph = await store.lineage(pageId);
      expect(new Set(graph.edges.map((e) => `${e.from_id} ${e.relation} ${e.to_id}`))).toEqual(
        new Set([
          `${pageId} depends_on ${claim.id}`,
          `${claim.id} cites ${spans[0].id}`,
          `${sv.id} contains ${spans[0].id}`,
        ]),
      );
      const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
      expect(labels.get(pageId)).toBe("Hotel standards");
      expect(labels.get(sv.id)).toBe(sv.title);
      expect(labels.get(claim.id)).toBe(claim.statement);
      expect(graph.truncated).toBe(false);

      const shallow = await store.lineage(pageId, 1);
      expect(shallow.truncated).toBe(true);
      expect(new Set(shallow.nodes.map((n) => n.id))).toEqual(new Set([pageId, claim.id]));
    });
  });

  describe.skipIf(skip)("transactions and events", () => {
    test("a failed transaction keeps nothing", async ({ store, kb, published }) => {
      const [sv, spans] = kb.sourceVersion(POLICY);
      const [claim, evidence] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", spans[0]);
      const event = newEvent(
        "claims.updated",
        { origin: "extracted", added: [claim.id], updated: [], superseded: [] },
        { tenantId: kb.tenantId, producer: "extraction" },
      );
      const write = async (tx: StoreTx) => {
        await tx.putSourceVersion(sv, spans);
        await tx.upsertClaims([claim], evidence);
        await tx.publish(event);
      };
      const e = await failing(store, async (tx) => {
        await write(tx);
        throw new Error("extractor crashed");
      });
      expect((e as Error).message).toBe("extractor crashed");
      expect(await store.getSourceVersion(sv.id)).toBeUndefined();
      expect(await store.getClaims([claim.id])).toEqual([]);
      expect(await published()).toEqual([]);

      await store.transaction(write);
      expect((await published()).map((x) => x.id)).toEqual([event.id]);
    });

    test("a transaction object cannot be used after it ends", async ({ store, kb }) => {
      let leaked: StoreTx | undefined;
      await store.transaction(async (tx) => {
        leaked = tx;
      });
      const [sv, spans] = kb.sourceVersion(POLICY);
      await expect(leaked?.putSourceVersion(sv, spans)).rejects.toThrow(/transaction has ended/);
      expect(await store.getSourceVersion(sv.id)).toBeUndefined();
    });
  });

  describe.skipIf(skip)("DataRef resolution", () => {
    test("claims data keeps claim IDs per row", async ({ store, kb }) => {
      const [, spans] = await seed(store, kb);
      const [tier1, e1] = kb.claim("tier-1 cities at most 600 yuan a night", spans[0], {
        quote: "tier-1 cities at most 600 yuan a night",
        subject_text: "tier-1 cities",
        predicate: "hotel_cap_per_night",
        value: { kind: "money", number: 600, currency: "CNY" },
        valid_time: { start: kb.now.toISOString() },
      });
      const [other, e2] = kb.claim("other cities at most 450 yuan a night", spans[0], {
        quote: "other cities at most 450 yuan a night",
        subject_text: "other cities",
        predicate: "hotel_cap_per_night",
        value: { kind: "money", number: 450, currency: "CNY" },
      });
      await store.transaction((tx) => tx.upsertClaims([tier1, other], [...e1, ...e2]));

      const pinned = await store.resolveData({ kind: "claims", claim_ids: [other.id, tier1.id], columns: COLUMNS });
      expect(pinned.rows).toEqual([
        ["other cities", 450, null],
        ["tier-1 cities", 600, tier1.valid_time.start],
      ]);
      expect(pinned.row_claim_ids).toEqual([[other.id], [tier1.id]]);
      expect(pinned.snapshot_hash).toMatch(/^sha256:/);

      const live: ClaimsData = {
        kind: "claims",
        query: { predicates: ["hotel_cap_per_night"] },
        refresh: { mode: "on_view" },
        columns: [COLUMNS[0], COLUMNS[1]],
      };
      const table = await store.resolveData(live);
      expect(table.rows).toEqual([
        ["tier-1 cities", 600],
        ["other cities", 450],
      ]);
      expect(table.snapshot_hash).not.toBe(pinned.snapshot_hash);
    });

    test("inline and query data", async ({ store }) => {
      const inline = await store.resolveData({
        kind: "inline",
        columns: [COLUMNS[0], COLUMNS[1]],
        rows: [["Beijing", 600]],
        row_claim_ids: [["clm_01JC0000000000000000000CL1"]],
      });
      expect(inline.rows).toEqual([["Beijing", 600]]);
      expect(inline.row_claim_ids).toEqual([["clm_01JC0000000000000000000CL1"]]);

      const columns: [DataColumn, DataColumn] = [
        { field: "query", field_type: "nominal" },
        { field: "n", field_type: "quantitative" },
      ];
      const table = await store.resolveData({
        kind: "query",
        provider: "static",
        query_id: "spend.by_city",
        params: { n: 3 },
        columns,
        refresh: { mode: "scheduled", schedule: "0 6 * * *" },
      });
      expect(table.rows).toEqual([["spend.by_city", 3]]);
      expect(table.snapshot_hash).toMatch(/^sha256:/);
      await expect(
        store.resolveData({
          kind: "query",
          provider: "jiandaoyun.records",
          query_id: "q",
          columns,
          refresh: { mode: "on_rebuild" },
        }),
      ).rejects.toThrow(/jiandaoyun/);
      await expect(store.resolveData({ kind: "claims", columns: COLUMNS })).rejects.toThrow(IntegrityError);
    });
  });

  describe.skipIf(skip)("ACL snapshots", () => {
    test("snapshots are kept per hash", async ({ store, kb }) => {
      const snap = (role: "viewer" | "editor", at: string): AclSnapshot => ({
        source_id: kb.sourceId,
        external_id: "doc-1",
        fidelity: "exact",
        entries: [{ principal_kind: "anyone_in_tenant", role }],
        captured_at: at,
        acl_hash: contentHash(role),
      });
      const old = snap("viewer", "2026-01-01T00:00:00Z");
      const next = snap("editor", "2026-02-01T00:00:00Z");
      await store.transaction(async (tx) => {
        await tx.putAclSnapshot(old);
        await tx.putAclSnapshot(next);
        await tx.putAclSnapshot(old); // repeated delivery
      });
      expect(await store.getAclSnapshot(kb.sourceId, "doc-1", old.acl_hash)).toEqual(old);
      expect(await store.getAclSnapshot(kb.sourceId, "doc-1")).toEqual(next);
      expect(await store.getAclSnapshot(kb.sourceId, "doc-2")).toBeUndefined();
    });
  });
});
