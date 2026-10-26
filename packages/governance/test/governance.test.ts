import { type Claim, type ClaimsUpdated, newEvent } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { VALUE_GROUPS } from "../src/index.ts";
import { BACKENDS, governanceTest, HOTEL, SPACE, TENANT } from "./fixtures.ts";

const POLICY = { title: "Travel policy", authority: 0.9, effective_from: "2026-01-01" };
const GUIDE = { title: "Onboarding guide", authority: 0.5 };

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("governance", () => {
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

    test("reference documents never outvote or hold up a governed value, and alone ask nobody", async ({ world }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      // Trusted and dated later, but a reference document.
      const blog = await world.state({ title: "Travel tips", authority: 0.95, level: "reference" }, [
        { text: "From 1 October 2026, hotels in Beijing 800 yuan a night.", value: 800, from: "2026-10-01" },
      ]);
      // Not a todo: a note for the owner, naming the reference document, its date and both values.
      const note = {
        kind: "note",
        space_id: SPACE,
        title: "hotel_cap_per_night (tier-1 city): 800 CNY/night in Travel tips, 600 CNY/night holds",
        detail: [
          "- **600 CNY/night** holds: 1 statement in 1 document, the most authoritative Travel policy.",
          "- 800 CNY/night (from 2026-10-01): 1 statement in 1 document, the most authoritative Travel tips. Travel tips, a reference document, says 800 CNY/night from 2026-10-01; the governed 600 CNY/night holds until a governed document says so. A note for the owner, not a todo.",
        ].join("\n"),
        priority: "low",
        unit_ids: [policy.claims[0]?.id, blog.claims[0]?.id],
        dedupe_key: "governance:note:hotel_cap_per_night|tier-1 city:800 CNY/night",
        batch_key: "governance:note:hotel_cap_per_night|tier-1 city",
        slot_key: HOTEL,
      };
      expect(blog.result).toEqual({ slots: [HOTEL], requests: [], notes: [note], withdrawn: [] });
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases).toEqual([
        {
          value: "800 CNY/night",
          classification: "contradiction",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.6,
          rationale:
            "Travel tips, a reference document, says 800 CNY/night from 2026-10-01; the governed 600 CNY/night holds until a governed document says so. A note for the owner, not a todo.",
          note: true,
        },
      ]);

      // Reference documents alone: decided for readers, with nobody to ask.
      const NEW_TIER = "hotel_cap_per_night|new tier-1 city";
      await world.state({ title: "Onboarding guide", authority: 0.5, level: "reference" }, [
        { text: "Hotels in Chengdu 450 yuan a night.", value: 450, slot: NEW_TIER },
      ]);
      const faq = await world.state({ title: "Staff Q&A", authority: 0.4, level: "reference" }, [
        { text: "Trips to Chengdu: hotels up to 500 yuan a night.", value: 500, slot: NEW_TIER },
      ]);
      expect(faq.result).toEqual({ slots: [NEW_TIER], requests: [], notes: [], withdrawn: [] });
      const alone = await world.governance.slot(TENANT, NEW_TIER);
      expect(alone.decision?.proposed.value).toBe("450 CNY/night");
      expect(alone.decision?.cases.map((c) => [c.value, c.classification, c.status])).toEqual([
        ["500 CNY/night", "contradiction", "open"],
      ]);
      expect(await world.requests()).toEqual([note]);

      // A governed notice says it too: the note goes, and the change is the owner's to confirm.
      const notice = await world.state({ title: "Notice on the hotel standard", authority: 0.5 }, [
        { text: "From 1 October 2026, hotels in Beijing 800 yuan a night.", value: 800, from: "2026-10-01" },
      ]);
      expect(notice.result).toMatchObject({ notes: [], withdrawn: [{ ...note, withdrawn: true }] });
      expect(notice.result.requests.map((r) => r.title)).toEqual([
        "hotel_cap_per_night (tier-1 city): 800 CNY/night or 600 CNY/night",
      ]);
    });

    test("a note is said again when its date changes, not when another document states the governed value", async ({
      world,
    }) => {
      await world.state(POLICY, [{ text: "The first-tier hotel cap is 600 a night.", value: 600 }]);
      const tips = await world.state({ title: "Travel tips", authority: 0.95, level: "reference" }, [
        { text: "From 2026-10-01 the Beijing hotel cap is 800 a night.", value: 800, from: "2026-10-01" },
      ]);
      const [first] = tips.result.notes;
      expect(first?.detail).toContain("800 CNY/night (from 2026-10-01)");

      // Extraction reads the same statement again as taking effect a month later.
      const claim = tips.claims[0] as Claim;
      await world.store.transaction((tx) =>
        tx.upsertClaims([{ ...claim, valid_time: { start: "2026-11-01T00:00:00Z" } }], []),
      );
      const update: ClaimsUpdated = { origin: "extracted", added: [], updated: [claim.id], superseded: [] };
      const moved = await world.governance.apply(
        newEvent("claims.updated", update, { tenantId: TENANT, producer: "extraction" }),
      );
      expect(moved.notes.map((n) => [n.title, n.dedupe_key, n.unit_ids])).toEqual([
        [first?.title, first?.dedupe_key, first?.unit_ids],
      ]);
      expect(moved.notes[0]?.detail).toContain("800 CNY/night (from 2026-11-01)");

      // A less authoritative governed document saying 600 too changes nothing the note says.
      const faq = await world.state({ title: "Expense FAQ", authority: 0.6 }, [
        { text: "Hotels in first-tier cities are capped at 600 a night.", value: 600 },
      ]);
      expect(faq.result).toMatchObject({ notes: [], withdrawn: [] });
      expect((await world.requests()).filter((r) => r.kind === "note")).toHaveLength(2);
    });

    test("a change only a reference document states is named in the case against its value", async ({ world }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      await world.state(GUIDE, [{ text: "On trips to Beijing, hotels within 800 yuan a night.", value: 800 }]);
      await world.state({ title: "Management meeting minutes", authority: 0.6, level: "reference" }, [
        {
          text: "Decided after discussion: from 1 October 2026, hotels in Beijing 800 yuan a night.",
          value: 800,
          from: "2026-10-01",
        },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases).toMatchObject([
        {
          value: "800 CNY/night",
          classification: "contradiction",
          status: "open",
          rationale:
            "600 CNY/night comes from the more authoritative Travel policy (0.9); 800 CNY/night from Onboarding guide (0.5). Management meeting minutes, a reference document, says 800 CNY/night from 2026-10-01.",
        },
      ]);
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

    test("reference documents neither bring a governed value forward nor plan one into a todo", async ({ world }) => {
      await world.state({ title: "Travel policy", authority: 0.8, effective_from: "2026-01-01" }, [
        { text: "The first-tier hotel cap is 600 a night.", value: 600 },
      ]);
      await world.state({ title: "Travel policy (2027 edition)", authority: 0.9, effective_from: "2027-01-01" }, [
        { text: "The first-tier hotel cap is 700 a night.", value: 700 },
      ]);
      // A reference FAQ says 700 already: the 2027 edition still holds only from its own day.
      await world.state({ title: "Travel FAQ", authority: 0.5, level: "reference" }, [
        { text: "Hotels in first-tier cities are capped at 700 a night.", value: 700 },
      ]);
      // A plan only a reference document states is a note, not a decision for the owner.
      const plan = await world.state({ title: "Budget proposal", authority: 0.5, level: "reference" }, [
        { text: "We plan to raise the first-tier hotel cap to 800 a night.", value: 800, type: "plan" },
      ]);
      expect(plan.result.requests).toEqual([]);
      expect(plan.result.notes.map((n) => n.title)).toEqual([
        "hotel_cap_per_night (tier-1 city): 800 CNY/night in Budget proposal, 600 CNY/night holds",
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status, c.rationale])).toEqual([
        ["700 CNY/night", "plan_vs_fact", "open", "700 CNY/night takes effect on 2027-01-01."],
        [
          "800 CNY/night",
          "plan_vs_fact",
          "auto_resolved",
          "Only reference documents plan 800 CNY/night; the governed 600 CNY/night holds. A note for the owner, not a todo.",
        ],
      ]);

      world.setToday("2027-01-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("700 CNY/night");
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
      const legacy = stored.map(({ governed: _governed, earliest_governed_from: _from, reference: _ref, ...g }) => g);
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
  });
});
