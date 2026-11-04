import { type Claim, type ClaimsUpdated, newEvent } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { BACKENDS, governanceTest, HOTEL, SPACE, TENANT } from "./fixtures.ts";

// What a reference document may do: its values never outvote or hold up a governed one and
// become notes for the page's owner, and a change it dates that is in effect holds until the
// governed page catches up, asking that page's owner.

const POLICY = { title: "Travel policy", authority: 0.9, effective_from: "2026-01-01" };

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("reference documents", () => {
    test("reference documents never outvote or hold up a governed value, and alone ask nobody", async ({ world }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      // Trusted, but a reference document, and it names no day the value changed.
      const blog = await world.state({ title: "Travel tips", authority: 0.95, level: "reference" }, [
        { text: "Hotels in Beijing: 800 yuan a night.", value: 800 },
      ]);
      // Not a todo: a note for the owner, naming the reference document and both values.
      const note = {
        kind: "note",
        space_id: SPACE,
        title: "hotel_cap_per_night (tier-1 city): 800 CNY/night in Travel tips, 600 CNY/night holds",
        detail: [
          "- **600 CNY/night** holds: 1 statement in 1 document, the most authoritative Travel policy.",
          "- 800 CNY/night: 1 statement in 1 document, the most authoritative Travel tips. Only reference documents state 800 CNY/night; the governed 600 CNY/night holds. A note for the owner, not a todo.",
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
            "Only reference documents state 800 CNY/night; the governed 600 CNY/night holds. A note for the owner, not a todo.",
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

    test("an old copy of the policy on a drive is out of date, and nobody hears of it", async ({ world }) => {
      const policy = await world.state(POLICY, [{ text: "Hotels are capped at 650 yuan a night.", value: 650 }]);
      const copy = await world.state(
        { title: "Travel policy (download)", authority: 0.5, level: "reference", modified_at: "2021-06-23T12:00:00Z" },
        [{ text: "Hotels are capped at 500 yuan a night.", value: 500 }],
      );
      expect(copy.result).toEqual({ slots: [HOTEL], requests: [], notes: [], withdrawn: [] });
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(policy.claims[0]?.id);
      expect(decision?.cases).toEqual([
        {
          value: "500 CNY/night",
          classification: "supersession",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.8,
          rationale:
            "Only reference documents state 500 CNY/night, the newest from 2021-06-23; the governed 650 CNY/night from 2026-01-01 holds, and an older document that says otherwise is out of date.",
        },
      ]);
      const [verdict] = await world.governance.verdicts(TENANT, [HOTEL]);
      expect(verdict?.values.map((v) => [v.value, v.standing])).toEqual([
        ["650 CNY/night", "holds"],
        ["500 CNY/night", "outdated"],
      ]);

      // A reference document newer than the policy may know something it does not: a note.
      const tips = await world.state(
        { title: "Travel tips", authority: 0.5, level: "reference", modified_at: "2026-10-20T12:00:00Z" },
        [{ text: "Hotels are capped at 700 yuan a night.", value: 700 }],
      );
      expect(tips.result.notes.map((n) => n.title)).toEqual([
        "hotel_cap_per_night (tier-1 city): 700 CNY/night in Travel tips, 650 CNY/night holds",
      ]);
    });

    test("a note is said again when its date changes, not when another document states the governed value", async ({
      world,
    }) => {
      await world.state(POLICY, [{ text: "The first-tier hotel cap is 600 a night.", value: 600 }]);
      // A change still ahead moves nothing yet: a note.
      const tips = await world.state({ title: "Travel tips", authority: 0.95, level: "reference" }, [
        { text: "From 2026-12-01 the Beijing hotel cap is 800 a night.", value: 800, from: "2026-12-01" },
      ]);
      const [first] = tips.result.notes;
      expect(first?.detail).toContain("800 CNY/night (from 2026-12-01)");

      // Extraction reads the same statement again as taking effect a month later.
      const claim = tips.claims[0] as Claim;
      await world.store.transaction((tx) =>
        tx.upsertClaims([{ ...claim, valid_time: { start: "2027-01-01T00:00:00Z" } }], []),
      );
      const update: ClaimsUpdated = { origin: "extracted", added: [], updated: [claim.id], superseded: [] };
      const moved = await world.governance.apply(
        newEvent("claims.updated", update, { tenantId: TENANT, producer: "extraction" }),
      );
      expect(moved.notes.map((n) => [n.title, n.dedupe_key, n.unit_ids])).toEqual([
        [first?.title, first?.dedupe_key, first?.unit_ids],
      ]);
      expect(moved.notes[0]?.detail).toContain("800 CNY/night (from 2027-01-01)");

      // A less authoritative governed document saying 600 too changes nothing the note says.
      const faq = await world.state({ title: "Expense FAQ", authority: 0.6 }, [
        { text: "Hotels in first-tier cities are capped at 600 a night.", value: 600 },
      ]);
      expect(faq.result).toMatchObject({ notes: [], withdrawn: [] });
      expect((await world.requests()).filter((r) => r.kind === "note")).toHaveLength(2);
    });

    test("a change a reference document dates holds until the policy catches up, and asks the policy's owner", async ({
      world,
    }) => {
      const policy = await world.state(POLICY, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 },
      ]);
      // A channel's announcements, exported to a drive in another space.
      const DRIVE = "spc_01JC00000000000000000DRIVE";
      const announcement = await world.state(
        { title: "#finance-announcements", authority: 0.5, level: "reference", space_id: DRIVE },
        [
          {
            text: "From 1 October 2026, hotels in Beijing are capped at 800 yuan a night, up from 600.",
            value: 800,
            from: "2026-10-01",
          },
        ],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("800 CNY/night");
      expect(decision?.basis).toBe("changed");
      expect(decision?.cases).toEqual([
        {
          value: "600 CNY/night",
          classification: "supersession",
          status: "open",
          priority: "high",
          confidence: 0.8,
          rationale:
            "600 CNY/night (1 document, the most authoritative Travel policy) predates the change to 800 CNY/night on 2026-10-01 in #finance-announcements. #finance-announcements is a reference document: the change holds until a governed document states it or a person rejects it.",
        },
      ]);
      const [verdict] = await world.governance.verdicts(TENANT, [HOTEL]);
      expect(verdict?.values.map((v) => [v.value, v.standing])).toEqual([
        ["800 CNY/night", "holds"],
        ["600 CNY/night", "outdated"],
      ]);
      // A todo, not a note, and it goes to the owner of the policy, not of the drive.
      expect(announcement.result.notes).toEqual([]);
      expect(announcement.result.requests).toMatchObject([
        {
          kind: "conflict",
          space_id: SPACE,
          priority: "high",
          title: "hotel_cap_per_night (tier-1 city): 800 CNY/night or 600 CNY/night",
          unit_ids: [announcement.claims[0]?.id, policy.claims[0]?.id],
        },
      ]);
      expect(announcement.result.requests[0]?.detail).toContain(
        "proposed (changed on 2026-10-01 in #finance-announcements, a reference document)",
      );

      // The policy's next edition takes the change in: the governed page holds it now, and the
      // announcement still says why 600 is out of date rather than disputed.
      await world.state({ ...POLICY, title: "Travel policy (October)", effective_from: "2026-10-15" }, [
        { text: "The hotel cap in tier-1 cities is 800 yuan a night.", value: 800 },
      ]);
      const adopted = (await world.governance.slot(TENANT, HOTEL)).decision;
      expect(adopted?.proposed.best.document).toBe("Travel policy (October)");
      expect(adopted?.cases.map((c) => [c.value, c.classification, c.status, c.rationale])).toEqual([
        [
          "600 CNY/night",
          "supersession",
          "open",
          "600 CNY/night (1 document, the most authoritative Travel policy) predates the change to 800 CNY/night on 2026-10-01 in #finance-announcements.",
        ],
      ]);
      const [after] = await world.governance.verdicts(TENANT, [HOTEL]);
      expect(after?.values.map((v) => [v.value, v.standing])).toEqual([
        ["800 CNY/night", "holds"],
        ["600 CNY/night", "outdated"],
      ]);
    });

    test("a reference document's change still ahead, or older than the policy, moves nothing", async ({ world }) => {
      await world.state(POLICY, [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", value: 600 }]);
      // Announced for December; on 23 October the policy still holds, and the day is rechecked.
      await world.state({ title: "#finance-announcements", authority: 0.5, level: "reference" }, [
        { text: "From 1 December 2026, hotels in Beijing 800 yuan a night.", value: 800, from: "2026-12-01" },
      ]);
      // Changed before the policy took effect: the policy already says what holds.
      await world.state({ title: "Old minutes", authority: 0.6, level: "reference" }, [
        { text: "From 1 June 2025, hotels in Beijing 550 yuan a night.", value: 550, from: "2025-06-01" },
      ]);
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.value).toBe("600 CNY/night");
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status])).toEqual([
        ["550 CNY/night", "contradiction", "auto_resolved"],
        ["800 CNY/night", "contradiction", "auto_resolved"],
      ]);
      world.setToday("2026-12-01");
      expect((await world.governance.recheck(TENANT)).slots).toEqual([HOTEL]);
      expect((await world.governance.slot(TENANT, HOTEL)).decision?.proposed.value).toBe("800 CNY/night");
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
  });
});
