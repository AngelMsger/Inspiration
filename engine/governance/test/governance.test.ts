import { readFileSync } from "node:fs";
import type { TodoRequested } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { MEMBERS, RECHECKS, sourcesOf, VALUE_GROUPS, type ValueGroup } from "../src/index.ts";
import { BACKENDS, governanceTest, HOTEL, SPACE, TENANT, type World } from "./fixtures.ts";

const POLICY = { title: "Travel policy", authority: 0.9, effective_from: "2026-01-01" };
const GUIDE = { title: "Onboarding guide", authority: 0.5 };
/** A source's documents by file, without the source ID governance names them by. */
const files = (documents: string[]) => documents.map((d) => d.slice(d.indexOf(":") + 1));

/**
 * The slot's state as an older governance stored it: its groups without the fields named (the
 * day counts came first, then the best by day, then the sources, when members also began to
 * keep their document and copy keys, then the newest date, when they began to keep their
 * document's date), and no recheck for the day a statement takes effect.
 */
async function storedWithout(
  world: World,
  fields: readonly ("governed_from" | "best_from" | "sources" | "newest")[],
): Promise<void> {
  const without = <T extends object>(row: T, names: readonly string[]) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !names.includes(k))) as T;
  const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
  const legacy = stored.map((g) => without(g, fields));
  const memberFields = [
    ...(fields.includes("sources") ? ["document_key", "copy_keys"] : []),
    ...(fields.includes("newest") ? ["modified"] : []),
  ];
  const members = memberFields.length
    ? (await world.records.find(MEMBERS, { tenant_id: TENANT, slot: HOTEL })).map((m) => without(m, memberFields))
    : [];
  await world.records.transaction(async (tx) => {
    await tx.put(VALUE_GROUPS, legacy);
    if (members.length) await tx.put(MEMBERS, members);
    await tx.delete(
      RECHECKS,
      (await tx.find(RECHECKS, { tenant_id: TENANT })).map((r) => `${r.tenant_id}\x1f${r.slot}`),
    );
  });
}

/** A policy says 600; a guide says 700 today, and a stronger 2027 edition says 700 from its day. */
async function laterAndStronger(world: World): Promise<void> {
  await world.state({ title: "Travel policy", authority: 0.8, effective_from: "2026-01-01" }, [
    { text: "The hotel cap is 600 yuan a night.", value: 600 },
  ]);
  await world.state({ title: "Onboarding guide", authority: 0.5 }, [
    { text: "Hotels are capped at 700 yuan a night.", value: 700 },
  ]);
  await world.state({ title: "Travel policy (2027 edition)", authority: 0.9, effective_from: "2027-01-01" }, [
    { text: "The hotel cap is 700 yuan a night.", value: 700 },
  ]);
}

/** A rule reposted in three folders says 600; two handbooks say 650, each in its own words. */
async function reposted(world: World): Promise<void> {
  const rule = "From now on, hotels in every tier-1 city are capped at 600 yuan a night.";
  for (const external_id of ["notice.md", "sales/notice.md", "support/notice.md"]) {
    await world.state({ ...POLICY, title: "Hotel notice", external_id }, [{ text: rule, value: 600 }]);
  }
  await world.state({ ...POLICY, title: "Sales handbook" }, [{ text: "Hotels: 650 yuan a night.", value: 650 }]);
  await world.state({ ...POLICY, title: "Support handbook" }, [
    { text: "We pay up to 650 yuan a night for hotels.", value: 650 },
  ]);
}

/** Two governed documents of equal authority state 600 and 650; the claim IDs, random here, pick the leader. */
async function tied(world: World): Promise<{ leader: number; other: number }> {
  await world.state({ title: "Travel policy", authority: 0.9 }, [
    { text: "The hotel cap is 600 yuan a night.", value: 600 },
  ]);
  await world.state({ title: "Travel standard", authority: 0.9 }, [
    { text: "The hotel cap is 650 yuan a night.", value: 650 },
  ]);
  const proposed = (await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value;
  return proposed === "600 CNY/night" ? { leader: 600, other: 650 } : { leader: 650, other: 600 };
}

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("governance", () => {
    describe("once the revised policy states the change itself", () => {
      const revised = async (world: World) => {
        await world.state({ ...POLICY, effective_from: "2026-10-01" }, [
          { text: "The hotel cap in tier-1 cities is 650 yuan a night.", value: 650 },
        ]);
        await world.state({ title: "Notice on the tier-1 city hotel standard", authority: 0.5 }, [
          {
            text: "From 1 October 2026 the hotel cap rises from 600 to 650 yuan a night.",
            value: 650,
            from: "2026-10-01",
          },
        ]);
      };
      const against = async (world: World) =>
        (await world.governance.conflicts(TENANT)).map((c) => [c.classification, c.status]);

      test("an older document that still says 600 is out of date, and its owner is still asked", async ({ world }) => {
        await revised(world);
        await world.state({ title: "Onboarding guide", authority: 0.5, effective_from: "2026-03-01" }, [
          { text: "Hotels in tier-1 cities: up to 600 yuan a night.", value: 600 },
        ]);
        const { decision } = await world.governance.slot(TENANT, HOTEL);
        expect([decision?.proposed.value, decision?.basis]).toEqual(["650 CNY/night", "authority"]);
        expect(await against(world)).toEqual([["supersession", "open"]]);
        expect((await world.requests()).map((r) => r.kind)).toEqual(["conflict"]);
      });

      test("a document dated after the change that still says 600 is in dispute", async ({ world }) => {
        await revised(world);
        await world.state({ title: "Sales handbook", authority: 0.5, effective_from: "2026-10-12" }, [
          { text: "Hotels in tier-1 cities: up to 600 yuan a night.", value: 600 },
        ]);
        expect(await against(world)).toEqual([["contradiction", "open"]]);
      });
    });

    test("a dated change outranks the policy until it is revised; archived values settle alone", async ({ world }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      expect(policy.result.requests).toEqual([]);
      const archive = await world.state(
        {
          title: "Travel policy (2023 edition)",
          authority: 0.3,
          approval_state: "archived",
          effective_from: "2023-03-01",
        },
        [{ text: "The hotel cap in tier-1 cities is 500 yuan a night.", value: 500 }],
      );
      expect(archive.result).toEqual({ slots: [HOTEL], requests: [], notes: [], withdrawn: [] });
      await world.state({ title: "FAQ", authority: 0.5 }, [
        { text: "Trips to Beijing: hotels 600 yuan a night.", value: 600 },
      ]);
      const notice = await world.state({ title: "Notice on the tier-1 city hotel standard", authority: 0.5 }, [
        {
          text: "From 1 October 2026 the hotel cap rises from 600 to 650 yuan a night.",
          value: 650,
          from: "2026-10-01",
        },
      ]);

      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("650 CNY/night");
      expect(decision?.basis).toBe("changed");
      const cases = await world.governance.conflicts(TENANT);
      expect(Object.fromEntries(cases.map((c) => [c.rationale?.split(" ")[0], [c.classification, c.status]]))).toEqual({
        "600": ["supersession", "open"],
        Only: ["supersession", "auto_resolved"],
      });
      expect(cases.every((c) => c.proposed_winner_id === notice.claims[0]?.id && c.tier === "deterministic")).toBe(
        true,
      );

      expect(await world.requests()).toEqual([
        {
          kind: "conflict",
          space_id: SPACE,
          title: "hotel_cap_per_night (tier-1 city): 650 CNY/night or 600 CNY/night",
          detail: [
            "- **650 CNY/night**, proposed (changed on 2026-10-01 in Notice on the tier-1 city hotel standard): 1 statement in 1 document, the most authoritative Notice on the tier-1 city hotel standard.",
            "- 600 CNY/night, supersession: 2 statements in 2 documents, the most authoritative Travel policy. 600 CNY/night (2 documents, the most authoritative Travel policy) predates the change to 650 CNY/night on 2026-10-01 in Notice on the tier-1 city hotel standard.",
          ].join("\n"),
          priority: "high",
          unit_ids: [notice.claims[0]?.id, policy.claims[0]?.id],
          dedupe_key: "governance:conflict:hotel_cap_per_night|tier-1 city",
          batch_key: "governance:conflict:hotel_cap_per_night",
          slot_key: HOTEL,
          resolutions: [
            ["Keep", "650 CNY/night", notice.claims[0]?.id],
            ["Choose", "600 CNY/night", policy.claims[0]?.id],
          ].map(([verb, value, claim]) => ({
            key: `choose:${value}`,
            label: `${verb} ${value}`,
            effect: { slot_key: HOTEL, value, question: expect.stringMatching(/^sha256:/), claim_id: claim },
          })),
        },
      ]);
    });

    test("a document that takes effect later changes the current value only from its day", async ({ world }) => {
      const current = await world.state({ title: "Travel policy", authority: 0.8, effective_from: "2026-01-01" }, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      // The new edition's claims take its effective date, as extraction gives them.
      await world.state({ title: "Travel policy (2027 edition)", authority: 0.9, effective_from: "2027-01-01" }, [
        { text: "The hotel cap in tier-1 cities is 700 yuan a night.", value: 700 },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.proposed.best.claim_id).toBe(current.claims[0]?.id);
      expect(decision?.cases).toMatchObject([
        {
          value: "700 CNY/night",
          classification: "plan_vs_fact",
          priority: "low",
          rationale: "700 CNY/night takes effect on 2027-01-01.",
        },
      ]);

      // On its day the slot is decided again, and the new edition is current.
      world.setToday("2027-01-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("700 CNY/night");
    });

    test("groups stored before their newest date are counted again, each member dated by its source version", async ({
      world,
    }) => {
      await world.state(POLICY, [{ text: "Hotels are capped at 650 yuan a night.", value: 650 }]);
      await world.state(
        { title: "Travel policy (download)", authority: 0.5, level: "reference", modified_at: "2021-06-23T12:00:00Z" },
        [{ text: "Hotels are capped at 500 yuan a night.", value: 500 }],
      );
      await storedWithout(world, ["newest"]);
      // A recheck decides the slot again: the old copy is still out of date, and nobody is told.
      await world.records.transaction((tx) => tx.put(RECHECKS, [{ tenant_id: TENANT, slot: HOTEL, day: "" }]));
      const rechecked = await world.governance.recheck(TENANT);
      expect(rechecked).toMatchObject({ slots: [HOTEL], requests: [], notes: [] });
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status])).toEqual([
        ["500 CNY/night", "supersession", "auto_resolved"],
      ]);
      const members = await world.records.find(MEMBERS, { tenant_id: TENANT, slot: HOTEL });
      expect(members.map((m) => m.modified).sort()).toEqual(["", "2021-06-23"]);
    });

    test("a contradiction proposes the more authoritative source and asks once", async ({ world }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      const guide = await world.state(GUIDE, [
        { text: "On trips to Beijing, hotels within 700 yuan a night.", value: 700 },
      ]);
      expect(guide.result.requests).toMatchObject([
        { title: "hotel_cap_per_night (tier-1 city): 600 CNY/night or 700 CNY/night", priority: "normal" },
      ]);
      expect(guide.result.requests[0]?.unit_ids).toEqual([policy.claims[0]?.id, guide.claims[0]?.id]);
      const [conflict] = await world.governance.conflicts(TENANT);
      expect(conflict).toMatchObject({ classification: "contradiction", status: "open", batch_key: HOTEL });

      // Another document repeating a known value changes counts, not the decision.
      const again = await world.state({ title: "Onboarding guide (second edition)", authority: 0.5 }, [
        { text: "Hotels in Beijing 700 yuan a night.", value: 700 },
      ]);
      expect(again.result).toEqual({ slots: [HOTEL], requests: [], notes: [], withdrawn: [] });
      const groups = (await world.governance.slot(TENANT, HOTEL)).groups;
      expect(Object.fromEntries(groups.map((g) => [g.value, [g.count, g.versions.length]]))).toEqual({
        "600 CNY/night": [1, 1],
        "700 CNY/night": [2, 2],
      });

      // A redelivered update is a no-op.
      expect(await world.governance.apply(again.event)).toEqual({ slots: [], requests: [], notes: [], withdrawn: [] });
      expect((await world.governance.slot(TENANT, HOTEL)).groups.find((g) => g.value === "700 CNY/night")?.count).toBe(
        2,
      );
      expect(await world.requests()).toHaveLength(1);
    });

    test("between equally authoritative statements, the value more governed statements state leads", async ({
      world,
    }) => {
      // The policy states its article and, in passing, another number for the same slot; a
      // governed copy repeats the article. Claim IDs are random here, so six slots would catch
      // a tie left to them.
      const slots = Array.from({ length: 6 }, (_, k) => `hotel_cap_per_night|city ${k + 1}`);
      await world.state(
        POLICY,
        slots.flatMap((slot, k) => [
          { slot, text: `Article ${k + 1} The hotel cap is 600 yuan a night.`, value: 600 },
          { slot, text: `Objections to article ${k + 1} are heard within 650 hours.`, value: 650 },
        ]),
      );
      await world.state(
        { ...POLICY, title: "Travel policy (forwarded)" },
        slots.map((slot, k) => ({ slot, text: `Article ${k + 1} The hotel cap is 600 yuan a night.`, value: 600 })),
      );
      for (const slot of slots) {
        expect((await world.governance.slot(TENANT, slot)).decision?.proposed.value, slot).toBe("600 CNY/night");
      }
    });

    test("copies of one passage are one source: a reposted rule does not outvote two in their own words", async ({
      world,
    }) => {
      await reposted(world);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("650 CNY/night");
      expect(Object.fromEntries(groups.map((g) => [g.value, sourcesOf(g).map(files)]))).toEqual({
        "600 CNY/night": [["notice.md", "sales/notice.md", "support/notice.md"]],
        "650 CNY/night": [["Sales handbook.md"], ["Support handbook.md"]],
      });
    });

    test("groups stored before their sources are counted again from their members", async ({ world }) => {
      await reposted(world);
      await storedWithout(world, ["sources"]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("650 CNY/night");
    });

    test("members stored before their document was kept count by their document when their group is counted again", async ({
      world,
    }) => {
      await world.state(POLICY, [
        { text: "Hotels: 600 yuan a night.", value: 600 },
        { text: "Article 9 Hotels are capped at 600 yuan.", value: 600 },
        { text: "In short, 600 yuan a night for hotels.", value: 600 },
      ]);
      await world.state({ ...POLICY, title: "Sales handbook" }, [{ text: "Hotels: 700 yuan a night.", value: 700 }]);
      await world.state({ ...POLICY, title: "Support handbook" }, [
        { text: "We pay up to 700 yuan a night for hotels.", value: 700 },
      ]);
      await storedWithout(world, ["sources"]);
      // A new statement makes the stored group be counted again, and its members be stored with their keys.
      await world.state({ ...POLICY, title: "Engineering handbook" }, [
        { text: "Hotels cost at most 600 yuan a night.", value: 600 },
      ]);
      const { groups } = await world.governance.slot(TENANT, HOTEL);
      expect(groups.map((g) => [g.value, g.count, sourcesOf(g).length])).toEqual([
        ["600 CNY/night", 4, 2],
        ["700 CNY/night", 2, 2],
      ]);
      const members = await world.records.find(MEMBERS, { tenant_id: TENANT, slot: HOTEL });
      expect(members.every((m) => m.document_key && m.copy_keys)).toBe(true);
    });

    test("a short rule worded alike in two documents is two sources; one document stating it twice is one", async ({
      world,
    }) => {
      await world.state(POLICY, [
        { text: "Hotels: 600 yuan a night.", value: 600 },
        { text: "Article 9 Hotels are capped at 600 yuan.", value: 600 },
      ]);
      await world.state({ ...POLICY, title: "Sales handbook" }, [{ text: "Hotels: 650 yuan a night.", value: 650 }]);
      await world.state({ ...POLICY, title: "Support handbook" }, [{ text: "Hotels: 650 yuan a night.", value: 650 }]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("650 CNY/night");
      expect(groups.map((g) => [g.value, g.count, sourcesOf(g).length])).toEqual([
        ["600 CNY/night", 2, 1],
        ["650 CNY/night", 2, 2],
      ]);
    });

    test("without effective dates, the copy of the policy changed later is the newer one", async ({ world }) => {
      const current = await world.state(
        { title: "Travel policy", authority: 0.9, external_id: "travel.md", modified_at: "2026-09-13T08:00:00Z" },
        [{ text: "Hotels are capped at 650 yuan a night.", value: 650 }],
      );
      await world.state(
        {
          title: "Travel policy",
          authority: 0.9,
          external_id: "travel-backup.md",
          modified_at: "2024-02-08T08:00:00Z",
        },
        [{ text: "Hotels are capped at 600 yuan a night.", value: 600 }],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(current.claims[0]?.id);
      // The backup had not changed for more than a year when the policy did: left behind.
      expect(decision?.cases.map((c) => [c.value, c.classification, c.rationale])).toEqual([
        [
          "600 CNY/night",
          "supersession",
          "600 CNY/night (1 document, the most authoritative Travel policy, from 2024-02-08) is older than 650 CNY/night in Travel policy, from 2026-09-13, which is as authoritative and has as many independent sources.",
        ],
      ]);
    });

    test("two governed documents in use that disagree are a contradiction, though one is newer", async ({ world }) => {
      await world.state({ title: "Networking runbook", authority: 0.7, modified_at: "2026-08-04T08:00:00Z" }, [
        { text: "Each namespace gets at most 3 LoadBalancer Services.", value: 3 },
      ]);
      const standards = await world.state(
        { title: "Cluster standards", authority: 0.7, modified_at: "2026-09-15T08:00:00Z" },
        [{ text: "A namespace may have at most 5 Services of type LoadBalancer.", value: 5 }],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(standards.claims[0]?.id);
      // Six weeks newer does not show the runbook is wrong: both stand until a person decides.
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status, c.priority, c.rationale])).toEqual([
        [
          "3 CNY/night",
          "contradiction",
          "open",
          "normal",
          "5 CNY/night in Cluster standards, from 2026-09-15, is newer than 3 CNY/night (1 document, the most authoritative Networking runbook, from 2026-08-04), which is as authoritative and has as many independent sources; a newer document does not show that another one is wrong.",
        ],
      ]);
      const [verdict] = await world.governance.verdicts(TENANT, [HOTEL]);
      expect(verdict?.values.map((v) => [v.value, v.standing])).toEqual([
        ["5 CNY/night", "holds"],
        ["3 CNY/night", "disputed"],
      ]);
    });

    test("a paragraph pasted into older handbooks is one source, and the newer policy supersedes it", async ({
      world,
    }) => {
      const paragraph = "Meals and hotels. Hotels are capped at 600 yuan a night; keep every receipt.";
      for (const title of ["Sales handbook", "Support handbook", "Engineering handbook"]) {
        await world.state({ title, authority: 0.9, effective_from: "2025-01-01" }, [
          { text: "Hotels are capped at 600 yuan a night", value: 600, paragraph },
          // A paragraph of its own, so only the pasted one, not the whole text, is shared.
          {
            text: `${title} questions go to the team lead within 3 days.`,
            value: 3,
            slot: "questions_days",
            paragraph: `${title} questions go to the team lead within 3 days.`,
          },
        ]);
      }
      const policy = await world.state(POLICY, [{ text: "The hotel cap is 650 yuan a night.", value: 650 }]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(policy.claims[0]?.id);
      expect(sourcesOf(groups.find((g) => g.value === "600 CNY/night") as ValueGroup).map(files)).toEqual([
        ["Engineering handbook.md", "Sales handbook.md", "Support handbook.md"],
      ]);
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status, c.rationale])).toEqual([
        [
          "600 CNY/night",
          "supersession",
          "open",
          // Claim IDs, random here, pick which handbook is the most authoritative.
          expect.stringMatching(
            /^600 CNY\/night \(3 documents, the most authoritative \w+ handbook, from 2025-01-01\) is older than 650 CNY\/night in Travel policy, from 2026-01-01, which is as authoritative and has as many independent sources\.$/,
          ),
        ],
      ]);
    });

    test("a short document reposted whole is one source, though none of its passages is long enough alone", async ({
      world,
    }) => {
      const notice = [
        {
          text: "Hotels in tier-1 cities: 600 yuan a night.",
          value: 600,
          paragraph: "Hotels in tier-1 cities: 600 yuan a night.",
        },
        { text: "Taxis: 40 yuan a day.", value: 40, slot: "taxi_cap_per_day", paragraph: "Taxis: 40 yuan a day." },
      ];
      await world.state({ ...POLICY, title: "Notice", external_id: "notice.md" }, notice);
      await world.state({ ...POLICY, title: "Notice", external_id: "sales/notice.md" }, notice);
      const { groups } = await world.governance.slot(TENANT, HOTEL);
      expect(groups.map((g) => sourcesOf(g).map(files))).toEqual([[["notice.md", "sales/notice.md"]]]);
    });

    test("a translation is one source with the text it translates", async ({ world }) => {
      await world.state({ ...POLICY, external_id: "travel-policy.md" }, [
        { text: "The hotel cap is 600 yuan a night.", value: 600 },
      ]);
      // Its words would be Chinese; what makes it a translation is the key.
      await world.state({ ...POLICY, external_id: "travel-policy.zh.md", translation_of: "travel-policy.md" }, [
        { text: "Hotel cap 600 yuan per night.", value: 600 },
      ]);
      await world.state({ ...POLICY, title: "Sales handbook" }, [{ text: "Hotels: 650 yuan a night.", value: 650 }]);
      await world.state({ ...POLICY, title: "Support handbook" }, [
        { text: "We pay up to 650 yuan a night for hotels.", value: 650 },
      ]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect(groups.map((g) => [g.value, sourcesOf(g).map(files)])).toEqual([
        ["600 CNY/night", [["travel-policy.md", "travel-policy.zh.md"]]],
        ["650 CNY/night", [["Sales handbook.md"], ["Support handbook.md"]]],
      ]);
      expect(decision?.proposed.value).toBe("650 CNY/night");
    });

    test("a translation that says otherwise than its original is out of date, and asks nobody", async ({ world }) => {
      const original = await world.state({ ...POLICY, external_id: "travel-policy.md" }, [
        { text: "The hotel cap is 650 yuan a night.", value: 650 },
      ]);
      // Translated before the original changed 600 to 650, and two of them.
      for (const external_id of ["travel-policy.zh.md", "travel-policy.ja.md"]) {
        await world.state({ ...POLICY, external_id, translation_of: "travel-policy.md" }, [
          { text: "Hotel cap 600 yuan per night.", value: 600 },
        ]);
      }
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(original.claims[0]?.id);
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status, c.rationale])).toEqual([
        [
          "600 CNY/night",
          "supersession",
          "auto_resolved",
          "Only translations (2 documents) state 600 CNY/night, of documents that state 650 CNY/night: the original holds, and a translation that says otherwise is out of date.",
        ],
      ]);
      expect(await world.requests()).toEqual([]);
    });

    test("a translation counts as any document against a value its original does not state", async ({ world }) => {
      await world.state({ ...POLICY, external_id: "travel-policy.md" }, [
        { text: "Meals are paid at 100 yuan a day.", value: 100, slot: "meal_allowance_per_day" },
      ]);
      await world.state({ ...POLICY, external_id: "travel-policy.zh.md", translation_of: "travel-policy.md" }, [
        { text: "Hotel cap 600 yuan per night.", value: 600 },
      ]);
      await world.state({ ...POLICY, title: "Travel standard" }, [{ text: "Hotels: 650 yuan a night.", value: 650 }]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.cases.map((c) => [c.classification, c.status])).toEqual([["contradiction", "open"]]);
    });

    test("verdicts say where each value stands, for readers", async ({ world }) => {
      const policy = await world.state({ ...POLICY, external_id: "travel-policy.md" }, [
        { text: "The hotel cap is 650 yuan a night.", value: 650 },
        { text: "Meals are paid at 100 yuan a day.", value: 100, slot: "meal_allowance_per_day" },
      ]);
      const translation = await world.state(
        { ...POLICY, external_id: "travel-policy.zh.md", translation_of: "travel-policy.md" },
        [{ text: "Hotel cap 600 yuan per night.", value: 600 }],
      );
      const guide = await world.state(GUIDE, [
        { text: "Meals: 120 yuan a day.", value: 120, slot: "meal_allowance_per_day" },
      ]);
      const verdicts = await world.governance.verdicts(TENANT, [HOTEL, "meal_allowance_per_day", HOTEL, "unknown"]);
      expect(verdicts.map((v) => v.slot_key)).toEqual([HOTEL, "meal_allowance_per_day"].sort());
      expect(verdicts.find((v) => v.slot_key === HOTEL)).toMatchObject({
        held_value: "650 CNY/night",
        disputed: false,
        values: [
          { value: "650 CNY/night", standing: "holds", claim_ids: [policy.claims[0]?.id] },
          { value: "600 CNY/night", standing: "outdated", claim_ids: [translation.claims[0]?.id] },
        ],
        decided_on: "2026-10-23",
      });
      expect(verdicts.find((v) => v.slot_key === "meal_allowance_per_day")).toMatchObject({
        held_value: "100 CNY/night",
        disputed: true,
        values: [
          { value: "100 CNY/night", standing: "holds" },
          { value: "120 CNY/night", standing: "disputed", claim_ids: [guide.claims[0]?.id] },
        ],
      });
    });

    test("a reference document does not break a tie between governed values", async ({ world }) => {
      const { leader, other } = await tied(world);
      await world.state({ title: "Travel FAQ", authority: 0.5, level: "reference" }, [
        { text: `Hotels are capped at ${other} a night.`, value: other },
      ]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${leader} CNY/night`);
    });

    test("a governed statement that takes effect later counts toward a tie from its day", async ({ world }) => {
      const { leader, other } = await tied(world);
      await world.state({ title: "Travel policy (2027 edition)", authority: 0.5, effective_from: "2027-01-01" }, [
        { text: `The hotel cap is ${other} yuan a night.`, value: other },
      ]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${leader} CNY/night`);
      expect((await world.records.find(RECHECKS, { tenant_id: TENANT })).map((r) => [r.slot, r.day])).toEqual([
        [HOTEL, "2027-01-01"],
      ]);

      world.setToday("2026-12-31");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([]);
      world.setToday("2027-01-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${other} CNY/night`);
    });

    test("groups stored before the day counts are counted again from their members", async ({ world }) => {
      const { leader, other } = await tied(world);
      await world.state({ title: "Travel policy (2027 edition)", authority: 0.5, effective_from: "2027-01-01" }, [
        { text: `The hotel cap is ${other} yuan a night.`, value: other },
      ]);
      await storedWithout(world, ["governed_from", "best_from"]);

      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${leader} CNY/night`);
      // A new statement in the slot stores the groups recounted and schedules the day again.
      await world.state({ title: "Travel FAQ", authority: 0.5, level: "reference" }, [
        { text: `Hotels are capped at ${other} a night.`, value: other },
      ]);
      expect((await world.records.find(RECHECKS, { tenant_id: TENANT })).map((r) => r.day)).toEqual(["2027-01-01"]);
      const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
      expect(stored.find((g) => g.value === `${other} CNY/night`)?.governed_from).toEqual({ "": 1, "2027-01-01": 1 });
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${leader} CNY/night`);

      world.setToday("2027-01-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${other} CNY/night`);
    });

    test("a statement that takes effect later lends its value no authority before its day", async ({ world }) => {
      await laterAndStronger(world);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases.map((c) => [c.value, c.classification, c.rationale])).toEqual([
        [
          "700 CNY/night",
          "contradiction",
          "600 CNY/night comes from the more authoritative Travel policy (0.8); 700 CNY/night from Onboarding guide (0.5).",
        ],
      ]);
      expect((await world.records.find(RECHECKS, { tenant_id: TENANT })).map((r) => r.day)).toEqual(["2027-01-01"]);

      world.setToday("2027-01-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("700 CNY/night");
    });

    test("groups stored before the best by day are counted again from their members", async ({ world }) => {
      await laterAndStronger(world);
      await storedWithout(world, ["best_from"]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("600 CNY/night");
    });

    test("plans and later dates do not override what is in force", async ({ world }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      await world.state({ title: "Budget proposal for 2027", authority: 0.5 }, [
        { text: "The plan is to raise the tier-1 city hotel cap to 800 yuan a night.", value: 800, type: "plan" },
      ]);
      await world.state({ title: "Notice on the 2027 hotel standard", authority: 0.5 }, [
        { text: "From 1 January 2027 the hotel cap is 700 yuan a night.", value: 700, from: "2027-01-01" },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases.map((c) => [c.value, c.classification, c.priority, c.rationale])).toEqual([
        ["700 CNY/night", "plan_vs_fact", "low", "700 CNY/night takes effect on 2027-01-01."],
        ["800 CNY/night", "plan_vs_fact", "low", "Only plans state 800 CNY/night."],
      ]);
    });

    test("groups stored before governance levels keep their governed date when a governed statement joins", async ({
      world,
    }) => {
      await world.state({ title: "Travel policy", authority: 0.9, effective_from: "2026-01-01" }, [
        { text: "The first-tier hotel cap is 600 a night.", value: 600 },
      ]);
      await world.state({ title: "Onboarding guide", authority: 0.5 }, [
        { text: "First-tier hotels are capped at 500 a night.", value: 500 },
      ]);
      // The groups as governance stored them before levels: no governed count or date.
      const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
      const legacy = stored.map(
        ({ governed: _governed, governed_from: _days, earliest_governed_from: _from, reference: _ref, ...g }) => g,
      );
      await world.records.transaction((tx) => tx.put(VALUE_GROUPS, legacy as typeof stored));
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("600 CNY/night");

      // The 2027 edition says 600 too, from its own day: 600 still holds today.
      await world.state({ title: "Travel policy (2027 edition)", authority: 0.8, effective_from: "2027-01-01" }, [
        { text: "The first-tier hotel cap stays 600 a night.", value: 600 },
      ]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(groups.find((g) => g.value === "600 CNY/night")).toMatchObject({
        live: 2,
        governed: 2,
        earliest_live_from: "2026-01-01",
        earliest_governed_from: "2026-01-01",
      });
    });

    test("a change announced for later is decided again on the day it takes effect", async ({ world }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      const notice = await world.state({ title: "Notice on the hotel standard", authority: 0.5 }, [
        { text: "From 1 December 2026 the hotel cap is 650 yuan a night.", value: 650, from: "2026-12-01" },
      ]);
      expect(notice.result.requests.map((r) => [r.title, r.priority])).toEqual([
        ["hotel_cap_per_night (tier-1 city): 600 CNY/night or 650 CNY/night", "low"],
      ]);

      world.setToday("2026-11-30");
      expect(await world.governance.recheck(TENANT)).toEqual({ slots: [], requests: [], notes: [], withdrawn: [] });
      world.setToday("2026-12-01");
      const due = await world.governance.recheck(TENANT);
      expect(due.slots).toEqual([HOTEL]);
      expect(due.requests.map((r) => [r.title, r.priority])).toEqual([
        ["hotel_cap_per_night (tier-1 city): 650 CNY/night or 600 CNY/night", "high"],
      ]);
      expect((await world.governance.conflicts(TENANT, "open")).map((c) => c.classification)).toEqual(["supersession"]);
      expect(await world.governance.recheck(TENANT)).toEqual({ slots: [], requests: [], notes: [], withdrawn: [] });
      expect(await world.requests()).toHaveLength(2);
    });

    test("the latest change in effect wins, even when the same value is announced again for later", async ({
      world,
    }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      const notice = (title: string, value: number, from: string) =>
        world.state({ title, authority: 0.5 }, [
          { text: `From ${from} the hotel cap is ${value} yuan a night.`, value, from },
        ]);
      await notice("June notice", 650, "2026-06-01");
      const august = await notice("August notice", 700, "2026-08-01");
      await notice("Notice for next year", 700, "2027-01-01");
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect([decision?.proposed.value, decision?.basis, decision?.change?.claim_id]).toEqual([
        "700 CNY/night",
        "changed",
        august.claims[0]?.id,
      ]);
      expect(decision?.cases.map((c) => [c.value, c.classification])).toEqual([
        ["600 CNY/night", "supersession"],
        ["650 CNY/night", "supersession"],
      ]);
    });

    test("a conflict whose statements go away settles, and asks again when it comes back", async ({ world }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      const guide = await world.state(GUIDE, [
        { text: "On trips to Beijing, hotels within 700 yuan a night.", value: 700 },
      ]);
      expect(guide.result.requests).toHaveLength(1);

      const closed = await world.close(guide.claims);
      // Nothing is left to decide, so the todo request is withdrawn.
      const asked = guide.result.requests[0];
      expect(closed).toEqual({ slots: [HOTEL], requests: [], notes: [], withdrawn: [{ ...asked, withdrawn: true }] });
      expect((await world.governance.conflicts(TENANT)).map((c) => [c.status, c.rationale])).toEqual([
        ["auto_resolved", "No longer in conflict."],
      ]);
      const { groups, decision } = await world.governance.slot(TENANT, HOTEL);
      expect([groups.map((g) => g.value), decision]).toEqual([["600 CNY/night"], undefined]);

      const back = await world.state({ title: "Onboarding guide (revised)", authority: 0.5 }, [
        { text: "Hotels in Beijing 700 yuan a night.", value: 700 },
      ]);
      expect(back.result.requests).toHaveLength(1);
      expect(await world.governance.conflicts(TENANT, "open")).toHaveLength(1);
      expect((await world.requests()).map((r) => [r.kind, r.withdrawn ?? false])).toEqual([
        ["conflict", false],
        ["conflict", true],
        ["conflict", false],
      ]);
    });

    test("an open todo whose statement goes, while another says the same, shows that one instead", async ({
      world,
    }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      const guide = await world.state(GUIDE, [
        { text: "On trips to Beijing, hotels within 700 yuan a night.", value: 700 },
      ]);
      const forwarded = await world.state({ title: "Forwarded guide", authority: 0.4 }, [
        { text: "Hotels in Beijing up to 700 yuan a night.", value: 700 },
      ]);
      // Another document saying 700 changes counts, not what the todo shows.
      expect(forwarded.result.requests).toEqual([]);

      // The question stays (600 proposed, 700 contradicts it), so the todo is sent again for the
      // statement it now shows, marked a refresh: collaboration replaces the open one.
      const closed = await world.close(guide.claims);
      expect(closed.requests.map((r) => [r.unit_ids, r.refresh])).toEqual([
        [[policy.claims[0]?.id, forwarded.claims[0]?.id], true],
      ]);
      expect(closed.requests[0]?.detail).toContain("1 statement in 1 document, the most authoritative Forwarded guide");
      expect(closed.withdrawn).toEqual([]);

      // A todo closed without a choice is not sent again when its statement goes.
      await world.resolve(closed.requests[0] as TodoRequested, { status: "dismissed" });
      await world.state({ title: "Team wiki", authority: 0.3 }, [
        { text: "Beijing hotels: 700 yuan a night at most.", value: 700 },
      ]);
      expect((await world.close(forwarded.claims)).requests).toEqual([]);
    });
  });
});

// Migrations run only on Postgres; the memory store holds nothing from before them.
describe.skipIf(BACKENDS[1]?.skip)("postgres backend", () => {
  const test = governanceTest("postgres");

  test("the migration rechecks slots whose groups were stored before the day counts", async ({ world }) => {
    const { leader, other } = await tied(world);
    await world.state({ title: "Travel policy (2027 edition)", authority: 0.5, effective_from: "2027-01-01" }, [
      { text: `The hotel cap is ${other} yuan a night.`, value: other },
    ]);
    await storedWithout(world, ["governed_from", "best_from"]);

    await world.sql?.(readFileSync(new URL("../migrations/0003_recount_groups.sql", import.meta.url), "utf8"));
    expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
    expect((await world.records.find(RECHECKS, { tenant_id: TENANT })).map((r) => r.day)).toEqual(["2027-01-01"]);
    const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
    expect(stored.every((g) => g.governed_from)).toBe(true);
    expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe(`${leader} CNY/night`);
  });

  test("migration 0005 rechecks slots whose groups were stored before their sources", async ({ world }) => {
    await reposted(world);
    await storedWithout(world, ["sources"]);

    await world.sql?.(readFileSync(new URL("../migrations/0005_sources.sql", import.meta.url), "utf8"));
    expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
    const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
    expect(stored.every((g) => g.sources)).toBe(true);
    expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("650 CNY/night");
  });

  test("migration 0006 rechecks slots whose groups were stored before their newest date", async ({ world }) => {
    await world.state(POLICY, [{ text: "Hotels are capped at 650 yuan a night.", value: 650 }]);
    await world.state(
      { title: "Travel policy (download)", authority: 0.5, level: "reference", modified_at: "2021-06-23T12:00:00Z" },
      [{ text: "Hotels are capped at 500 yuan a night.", value: 500 }],
    );
    await storedWithout(world, ["newest"]);

    await world.sql?.(readFileSync(new URL("../migrations/0006_newest.sql", import.meta.url), "utf8"));
    expect((await world.governance.recheck(TENANT)).notes).toEqual([]);
    const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
    expect(stored.every((g) => g.newest !== undefined)).toBe(true);
    const { decision } = await world.governance.slot(TENANT, HOTEL);
    expect(decision?.cases.map((c) => c.classification)).toEqual(["supersession"]);
  });

  test("migration 0004 rechecks slots whose groups were stored before the best by day", async ({ world }) => {
    await laterAndStronger(world);
    await storedWithout(world, ["best_from"]);

    await world.sql?.(readFileSync(new URL("../migrations/0004_best_by_day.sql", import.meta.url), "utf8"));
    expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
    expect((await world.records.find(RECHECKS, { tenant_id: TENANT })).map((r) => r.day)).toEqual(["2027-01-01"]);
    const stored = await world.records.find(VALUE_GROUPS, { tenant_id: TENANT, slot: HOTEL });
    expect(stored.every((g) => g.best_from)).toBe(true);
    expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("600 CNY/night");
  });
});
