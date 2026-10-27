import { type EventEnvelope, newEvent } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { BACKENDS, freshnessTest, TENANT } from "./fixtures.ts";

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = freshnessTest(backend);

  describe.skipIf(skip)("freshness", () => {
    test("a document is due when the shortest interval of its classes has passed since it changed", async ({
      world,
    }) => {
      world.setToday("2026-03-01");
      const policy = await world.put({ path: "Travel policy.md", modified: "2026-01-10" }, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", knowledge_class: "policy" },
        { text: "Contract hotel rates are updated every quarter.", knowledge_class: "pricing" },
        { text: "The new travel system is expected to go live on 1 June 2026.", on: "2026-06-01" },
      ]);
      // Records of a day, general knowledge and reference documents are never due by age.
      await world.put({ path: "Finance meeting minutes.md", modified: "2026-01-12", date: "2026-01-12" }, [
        { text: "The meeting decided to keep the hotel cap.", knowledge_class: "policy" },
      ]);
      await world.put({ path: "Project plan.md", modified: "2025-01-01" }, [
        { text: "The search module's P95 latency is 420 ms." },
      ]);
      const guide = await world.put({ path: "Travel tips.md", modified: "2025-01-01", level: "reference" }, [
        { text: "Trips to Beijing: hotels within 600 yuan a night.", knowledge_class: "policy" },
      ]);

      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.document.split(":")[1], d.kind, d.day])).toEqual([
        ["Travel policy.md", "ttl", "2026-04-10"],
        ["Travel policy.md", "assumption", "2026-06-01"],
      ]);
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      expect((await world.freshness.documents(TENANT)).map((d) => d.source_version_id)).not.toContain(guide.version.id);
      const [early] = await world.freshness.staleness(TENANT, [policy.version.id]);
      expect(early).toMatchObject({
        state: "fresh",
        age_component: 0.556,
        ttl: "P90D",
        review_due: "2026-04-10T00:00:00Z",
      });

      world.setToday("2026-04-10");
      expect(await world.freshness.tick(TENANT)).toEqual([
        {
          unit_ids: [policy.version.id],
          kind: "ttl",
          due_at: "2026-04-10T00:00:00Z",
          space_id: policy.version.space_id,
          reason: "Travel policy last changed on 2026-01-10; documents with pricing claims are reviewed every 90 days.",
          dedupe_key: `freshness:ttl:${policy.version.source_id}:Travel policy.md`,
        },
      ]);
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      const [due] = await world.freshness.staleness(TENANT, [policy.version.id]);
      expect(due).toMatchObject({ state: "stale", score: 1 });

      // The same version's claims again schedule nothing new; a new version restarts the clock.
      await world.deliver(
        newEvent(
          "claims.updated",
          { origin: "extracted", added: [], updated: [], superseded: [], source_version_id: policy.version.id },
          { tenantId: TENANT, producer: "extraction" },
        ),
      );
      expect((await world.freshness.upcoming(TENANT)).map((d) => d.kind)).toEqual(["assumption"]);
      await world.put(
        { path: "Travel policy.md", modified: "2026-04-10" },
        [{ text: "The hotel cap in tier-1 cities is 650 yuan a night.", knowledge_class: "policy" }],
        { previous: policy },
      );
      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.kind, d.day])).toEqual([["ttl", "2027-04-10"]]);
    });

    test("a plan's day brings an assumption review; a day already past, a record's plan or a plan without a day does not", async ({
      world,
    }) => {
      const report = await world.put({ path: "Spark project plan.md", modified: "2026-10-19" }, [
        { text: "The staged rollout is expected to finish on 20 November.", on: "2026-11-20" },
        { text: "The full launch is expected on 1 December.", on: "2026-12-01" },
        { text: "Interface testing was expected to finish on 1 September.", on: "2026-09-01" },
        { text: "120 tickets were handled this week." },
      ]);
      // A weekly report is a record of its week: the next report says what became of its plans.
      await world.put({ path: "Spark project weekly report.md", modified: "2026-10-23", date: "2026-10-23" }, [
        { text: "Acceptance is expected to finish on 25 November.", on: "2026-11-25" },
      ]);
      // A plan without a day is still a plan: its class sets no review interval.
      await world.put({ path: "Contract hotel rate plan.md", modified: "2026-10-01" }, [
        { text: "Contract hotel rates will change next year.", type: "plan", knowledge_class: "pricing" },
      ]);
      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.kind, d.day])).toEqual([
        ["assumption", "2026-11-20"],
        ["assumption", "2026-12-01"],
      ]);

      world.setToday("2026-11-25");
      const [review] = await world.freshness.tick(TENANT);
      const [rollout, , , tickets] = report.claims;
      expect(review).toMatchObject({
        kind: "assumption",
        unit_ids: [rollout?.id],
        reason: "Spark project plan planned 1 thing for 2026-11-20; check whether it happened.",
      });
      const scores = await world.freshness.staleness(TENANT, [rollout?.id as string, tickets?.id as string]);
      expect(scores.map((s) => s.state)).toEqual(["at_risk", "fresh"]);

      // A plan withdrawn before its day asks nothing.
      await world.put(
        { path: "Spark project plan.md", modified: "2026-11-26" },
        [{ text: "120 tickets were handled this week." }],
        {
          previous: report,
        },
      );
      world.setToday("2026-12-02");
      expect(await world.freshness.tick(TENANT)).toEqual([]);
      expect(await world.reviews()).toHaveLength(1);
    });

    test("an edit leaves its copies behind, but not the archive or a more authoritative original", async ({
      world,
    }) => {
      const policy = await world.put({ path: "policies/Travel policy.md", authority: 0.9, modified: "2026-01-01" }, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", knowledge_class: "policy" },
      ]);
      const archive = await world.put(
        {
          path: "archive/Travel policy (2023 edition).md",
          authority: 0.3,
          approval_state: "archived",
          modified: "2023-01-01",
        },
        [{ text: "The hotel cap in tier-1 cities is 500 yuan a night.", knowledge_class: "policy" }],
        { duplicates: [{ of: policy, similarity: 0.9 }] },
      );
      const copy = await world.put(
        { path: "shared/Fwd - Travel policy.md", authority: 0.4, modified: "2026-01-05" },
        [{ text: "The hotel cap in tier-1 cities is 600 yuan a night.", knowledge_class: "policy" }],
        {
          duplicates: [
            { of: policy, similarity: 1 },
            { of: archive, similarity: 0.9 },
          ],
        },
      );
      expect([...policy.reviews, ...archive.reviews, ...copy.reviews]).toEqual([]);

      const edited = await world.put(
        { path: "policies/Travel policy.md", authority: 0.9, modified: "2026-10-23" },
        [{ text: "The hotel cap in tier-1 cities is 650 yuan a night.", knowledge_class: "policy" }],
        {
          previous: policy,
          duplicates: [
            { of: archive, similarity: 0.8 },
            { of: copy, similarity: 0.9 },
          ],
        },
      );
      expect(edited.reviews).toEqual([
        {
          unit_ids: [copy.version.id],
          kind: "evidence_changed",
          due_at: "2026-10-23T09:00:00.000Z",
          space_id: copy.version.space_id,
          reason:
            "shared/Fwd - Travel policy repeats policies/Travel policy, which changed on 2026-10-23; it has not changed since.",
          cause_ids: [edited.version.id],
          dedupe_key: `freshness:evidence_changed:${copy.version.source_id}:shared/Fwd - Travel policy.md`,
        },
      ]);
      const [behind] = await world.freshness.staleness(TENANT, [copy.version.id]);
      expect(behind).toMatchObject({ state: "at_risk", upstream_component: 1 });

      // The copy catches up: it is fresh again, and the policy is not asked about the copy's edit.
      const caught = await world.put(
        { path: "shared/Fwd - Travel policy.md", authority: 0.4, modified: "2026-10-24" },
        [{ text: "The hotel cap in tier-1 cities is 650 yuan a night.", knowledge_class: "policy" }],
        { previous: copy, duplicates: [{ of: edited, similarity: 1 }] },
      );
      expect(caught.reviews).toEqual([]);
      const [fresh] = await world.freshness.staleness(TENANT, [caught.version.id]);
      expect(fresh?.state).toBe("fresh");
      expect(await world.reviews()).toHaveLength(1);
    });

    test("an edit of the original leaves its translations behind until they are translated again", async ({
      world,
    }) => {
      const policy = await world.put({ path: "Travel policy.md", authority: 0.9, modified: "2026-01-01" }, [
        { text: "The hotel cap is 600 yuan a night.", knowledge_class: "policy" },
      ]);
      const doc = (path: string, modified: string) => ({ path, modified, translation_of: "Travel policy.md" });
      const zh = await world.put(doc("Travel policy.zh.md", "2026-01-02"), [{ text: "Hotel cap 600 a night." }]);
      // Translated again the day after the edit.
      const ja = await world.put(doc("Travel policy.ja.md", "2026-01-02"), [{ text: "Hotel cap 600 a night." }]);
      const jaAgain = await world.put(doc("Travel policy.ja.md", "2026-10-23"), [{ text: "Hotel cap 650 a night." }], {
        previous: ja,
      });

      const edited = await world.put(
        { path: "Travel policy.md", authority: 0.9, modified: "2026-10-22" },
        [{ text: "The hotel cap is 650 yuan a night.", knowledge_class: "policy" }],
        { previous: policy },
      );
      expect(edited.reviews).toEqual([
        {
          unit_ids: [zh.version.id],
          kind: "evidence_changed",
          due_at: "2026-10-23T09:00:00.000Z",
          space_id: zh.version.space_id,
          reason:
            "Travel policy.zh translates Travel policy, which changed on 2026-10-22; it has not been translated again since.",
          cause_ids: [edited.version.id],
          dedupe_key: `freshness:evidence_changed:${zh.version.source_id}:Travel policy.zh.md`,
        },
      ]);
      expect(jaAgain.reviews).toEqual([]);
      const [behind] = await world.freshness.staleness(TENANT, [zh.version.id]);
      expect(behind).toMatchObject({ state: "at_risk", upstream_component: 1 });

      // Translated again: fresh, and an edit of a document that no longer names it as its original changes nothing.
      const caught = await world.put(
        { path: "Travel policy.zh.md", modified: "2026-10-24" },
        [{ text: "Hotel cap 650." }],
        {
          previous: zh,
        },
      );
      expect((await world.freshness.staleness(TENANT, [caught.version.id]))[0]?.state).toBe("fresh");
      world.setToday("2026-11-01");
      const again = await world.put(
        { path: "Travel policy.md", authority: 0.9, modified: "2026-10-31" },
        [{ text: "The hotel cap is 700 yuan a night.", knowledge_class: "policy" }],
        { previous: edited },
      );
      expect(again.reviews.map((r) => r.unit_ids)).toEqual([[jaAgain.version.id]]);
    });

    test("a translation that arrives after its original's edit is behind all the same", async ({ world }) => {
      const policy = await world.put({ path: "Travel policy.md", authority: 0.9, modified: "2025-01-01" }, [
        { text: "The hotel cap is 500 yuan a night.", knowledge_class: "policy" },
      ]);
      const edited = await world.put(
        { path: "Travel policy.md", authority: 0.9, modified: "2026-10-20" },
        [{ text: "The hotel cap is 600 yuan a night.", knowledge_class: "policy" }],
        { previous: policy },
      );
      const doc = (path: string, modified: string) => ({ path, modified, translation_of: "Travel policy.md" });
      const zh = await world.put(doc("Travel policy.zh.md", "2025-01-01"), [{ text: "Hotel cap 500 a night." }]);
      expect(zh.reviews).toEqual([
        {
          unit_ids: [zh.version.id],
          kind: "evidence_changed",
          due_at: "2026-10-23T09:00:00.000Z",
          space_id: zh.version.space_id,
          reason:
            "Travel policy.zh translates Travel policy, which changed on 2026-10-20; it has not been translated again since.",
          cause_ids: [edited.version.id],
          dedupe_key: `freshness:evidence_changed:${zh.version.source_id}:Travel policy.zh.md`,
        },
      ]);
      expect((await world.freshness.staleness(TENANT, [zh.version.id]))[0]).toMatchObject({
        state: "at_risk",
        upstream_component: 1,
      });
      // One translated after the edit, and one of an original never edited, are not behind.
      expect((await world.put(doc("Travel policy.ja.md", "2026-10-21"), [{ text: "Hotel cap 600." }])).reviews).toEqual(
        [],
      );
      await world.put({ path: "Leave policy.md", authority: 0.9, modified: "2026-10-20" }, [
        { text: "Leave is twenty days a year.", knowledge_class: "policy" },
      ]);
      const leave = await world.put(
        { path: "Leave policy.zh.md", modified: "2025-01-01", translation_of: "Leave policy.md" },
        [{ text: "Twenty days." }],
      );
      expect(leave.reviews).toEqual([]);
    });

    test("a review already due when its document arrives is marked as backlog", async ({ world }) => {
      world.setToday("2026-03-01");
      await world.put({ path: "Expenses FAQ.md", modified: "2025-01-01" }, [
        { text: "Travel expenses are claimed within 30 days of returning.", knowledge_class: "policy" },
      ]);
      await world.put({ path: "Travel policy.md", modified: "2026-01-10" }, [
        { text: "The hotel cap in tier-1 cities is 600 yuan a night.", knowledge_class: "policy" },
      ]);
      expect((await world.freshness.tick(TENANT)).map((r) => [r.reason, r.backlog])).toEqual([
        ["Expenses FAQ last changed on 2025-01-01; documents with policy claims are reviewed every 365 days.", true],
      ]);
      world.setToday("2027-01-10");
      expect((await world.freshness.tick(TENANT)).map((r) => r.backlog)).toEqual([undefined]);
    });

    test("a deleted document stays deleted: neither a redelivered nor a late event brings it back", async ({
      world,
    }) => {
      const guide = await world.put({ path: "Office guide.md", modified: "2026-05-01" }, [
        { text: "Claims must be filed within 30 days after a trip.", knowledge_class: "process" },
      ]);
      await world.deliver(guide.events[0] as EventEnvelope);
      expect((await world.freshness.upcoming(TENANT)).map((d) => d.day)).toEqual(["2026-10-28"]);

      // An edit whose events are still on their way when the document is deleted.
      world.setToday("2026-10-24");
      const edit = await world.put(
        { path: "Office guide.md", modified: "2026-10-24" },
        [{ text: "Claims must be filed within 15 days after a trip.", knowledge_class: "process" }],
        { previous: guide, hold: true },
      );
      world.setToday("2026-10-25");
      const gone = await world.put({ path: "Office guide.md", modified: "2026-10-25" }, [], {
        previous: edit,
        deleted: true,
      });
      expect(await world.freshness.documents(TENANT)).toEqual([]);
      for (const event of [...edit.events, ...gone.events]) await world.deliver(event);
      expect(await world.freshness.documents(TENANT)).toEqual([]);
      expect(await world.freshness.upcoming(TENANT)).toEqual([]);

      // Restored, it is a document again, with a new clock.
      world.setToday("2026-10-26");
      const back = await world.put(
        { path: "Office guide.md", modified: "2026-10-26" },
        [{ text: "Claims must be filed within 15 days after a trip.", knowledge_class: "process" }],
        { previous: gone },
      );
      expect((await world.freshness.documents(TENANT)).map((d) => d.source_version_id)).toEqual([back.version.id]);
      expect((await world.freshness.upcoming(TENANT)).map((d) => [d.kind, d.day])).toEqual([["ttl", "2027-04-24"]]);
    });
  });
});
