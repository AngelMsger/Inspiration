import {
  type Claim,
  type ClaimsUpdated,
  newEvent,
  payloadOf,
  slotOf,
  type TodoRequested,
  valueKeyOf,
} from "@inspiration/contracts";
import type { FakeProvider, MemoryUsage } from "@inspiration/model-gateway";
import { describe, expect } from "vitest";
import { BACKENDS, extractionTest, type Para, TENANT, type World } from "./fixtures.ts";

const HEADING = ["Travel policy", "Chapter 3 Lodging"];

const POLICY: Para[] = [
  {
    id: "p1",
    heading: HEADING,
    text: "Hotels in tier-1 cities cost at most 600 yuan a night. The lodging standard in Chengdu and Hangzhou is 450 yuan a night. Hotel costs are reimbursed against invoices.",
  },
  {
    id: "p2",
    heading: HEADING,
    text: "Travel expense claims must be filed within 30 days after the trip. Approved reimbursements are paid every Wednesday.",
  },
  { id: "p3", heading: HEADING, text: "Thanks, everyone. Any questions?" },
];

const claimsUpdated = (events: { type: string }[]) =>
  events
    .filter((e) => e.type === "claims.updated")
    .map((e) => payloadOf(e as never, "claims.updated") as ClaimsUpdated);

const todoRequests = (events: { type: string }[]) =>
  events
    .filter((e) => e.type === "todo.requested")
    .map((e) => payloadOf(e as never, "todo.requested") as TodoRequested);

describe.each(BACKENDS)("$backend store", ({ backend, skip }) => {
  const test = extractionTest(backend);

  describe.skipIf(skip)("extraction", () => {
    test("a claim is true from the day its passage names, else from the document's effective date", async ({
      world,
    }) => {
      const { result } = await world.version(
        "notice.md",
        [
          {
            id: "p1",
            text: "From 1 October 2026, hotels in tier-1 cities are capped at 650 yuan a night. The lodging standard in Chengdu is 450 yuan a night.",
          },
        ],
        { effectiveFrom: "2026-01-01" },
      );
      const claims = await world.store.getClaims(result.added);
      expect(Object.fromEntries(claims.map((c) => [c.value?.number, c.valid_time]))).toEqual({
        650: { start: "2026-10-01T00:00:00Z" },
        450: { start: "2026-01-01T00:00:00Z" },
      });
    });

    test("claims cite verbatim quotes and fill slots from the catalogue", async ({ world }) => {
      const { version, result } = await world.version("travel-policy.md", POLICY);
      expect(result).toMatchObject({
        windows: 1,
        failed_windows: 0,
        rejected: 0,
        superseded: [],
        unstated: [],
        restored: [],
      });
      const claims = await world.store.getClaims(result.added);
      const by = new Map(claims.map((c) => [c.statement, c]));
      expect([...by.keys()].sort()).toEqual(
        [
          "Hotels in tier-1 cities cost at most 600 yuan a night.",
          "The lodging standard in Chengdu and Hangzhou is 450 yuan a night.",
          "Hotel costs are reimbursed against invoices.",
          "Travel expense claims must be filed within 30 days after the trip.",
          "Approved reimbursements are paid every Wednesday.",
        ].sort(),
      );
      expect(by.get("Hotels in tier-1 cities cost at most 600 yuan a night.")).toMatchObject({
        predicate: "hotel_cap_per_night",
        qualifiers: ["tier-1 city"],
        slot_key: "hotel_cap_per_night|tier-1 city",
        value: { kind: "money", number: 600, currency: "CNY", normalized: "600 CNY/night" },
        claim_type: "rule",
        knowledge_class: "policy",
        subject_text: "Chapter 3 Lodging",
        status: "active",
        origin: "extracted",
        sensitivity: "internal",
        authority: 0.9,
      });
      expect(by.get("The lodging standard in Chengdu and Hangzhou is 450 yuan a night.")?.qualifiers).toEqual([
        "new tier-1 city",
      ]);
      expect(by.get("Hotel costs are reimbursed against invoices.")).toMatchObject({
        predicate: "hotel_cap_per_night",
      });
      expect(by.get("Hotel costs are reimbursed against invoices.")?.value).toBeUndefined();
      expect(by.get("Approved reimbursements are paid every Wednesday.")?.value).toEqual({
        kind: "enum",
        text: "every Wednesday",
        normalized: "every Wednesday",
      });
      const evidence = await world.store.evidenceOf(result.added);
      expect(evidence).toHaveLength(5);
      const spans = new Map((await world.store.spansOf(version.id)).map((s) => [s.id, s]));
      for (const e of evidence) {
        const span = spans.get(e.span_id);
        expect(span?.text.slice(e.quote_start, e.quote_end)).toBe(e.quote);
        expect(e.source_version_id).toBe(version.id);
      }
      const [event] = claimsUpdated(await world.events());
      expect(event).toEqual({
        origin: "extracted",
        added: result.added,
        updated: [],
        superseded: [],
        source_version_id: version.id,
      });

      // Doing it again finds the same claims and publishes nothing.
      const again = await world.extraction.extract({
        source_id: version.source_id,
        source_version_id: version.id,
        added_block_ids: (await world.store.blocksOf(version.id)).map((b) => b.id),
        changed_block_ids: [],
        removed_block_ids: [],
        added_span_ids: [],
        removed_span_ids: [],
      });
      expect(again.added).toEqual([]);
      expect(claimsUpdated(await world.events())).toHaveLength(1);
    });

    test("a reference document is read where it names a catalogue fact, and a passage in use in full", async ({
      world,
    }) => {
      const guide: Para[] = [
        {
          id: "g1",
          heading: ["Onboarding guide", "Travel"],
          text: "On trips to Beijing, hotels cost up to 700 yuan a night. Rooms must be booked a day ahead.",
        },
        {
          id: "g2",
          heading: ["Onboarding guide", "Office"],
          text: "Desks must be kept tidy. Computers must be shut down at the end of the day.",
        },
        {
          id: "g3",
          heading: ["Onboarding guide", "Travel"],
          text: "Travel expense claims must be filed within 30 days after the trip. Remember to keep the invoices.",
        },
      ];
      const { version, result } = await world.version("onboarding-guide.md", guide, { level: "reference" });
      const statements = async (ids: readonly string[]) =>
        (await world.store.getClaims(ids)).map((c) => [c.statement, c.slot_key ?? null]).sort();
      // Only the slot claims of the passages that name a catalogue fact; the booking rule waits.
      expect(result).toMatchObject({ windows: 1, rejected: 0, unused: 1 });
      expect(await statements(result.added)).toEqual([
        ["On trips to Beijing, hotels cost up to 700 yuan a night.", "hotel_cap_per_night|tier-1 city"],
        ["Travel expense claims must be filed within 30 days after the trip.", "travel_claim_deadline_days"],
      ]);

      const blocks = await world.store.blocksOf(version.id);
      const office = blocks.find((b) => b.anchor === "g2")?.id as string;
      const used = await world.extraction.extractOnUse(version.id, [office]);
      expect(await statements(used.added)).toEqual([
        ["Computers must be shut down at the end of the day.", null],
        ["Desks must be kept tidy.", null],
      ]);
      expect((await world.extraction.extractOnUse(version.id, [office])).added).toEqual([]);
    });

    test("a search-only document is never extracted", async ({ world }) => {
      const { version, result } = await world.version("group-chat.md", POLICY, { level: "search_only" });
      expect(result).toMatchObject({ windows: 0, added: [] });
      const blocks = await world.store.blocksOf(version.id);
      expect(await world.extraction.extractOnUse(version.id, [blocks[0]?.id as string])).toMatchObject({
        windows: 0,
        added: [],
      });
      expect(world.routed()).toEqual([]);
    });

    test("claims.updated carries on the correlation of the blocks.changed it answers", async ({ world }) => {
      const cause = newEvent(
        "blocks.changed",
        {
          source_id: "src_01JC0000000000000000FOLDER",
          source_version_id: "sv_01JC00000000000000000001",
          added_block_ids: [],
          changed_block_ids: [],
          removed_block_ids: [],
          added_span_ids: [],
          removed_span_ids: [],
        },
        { tenantId: TENANT, producer: "normalization", correlationId: "evt_01JC000000000000000000SYNC" },
      );
      await world.version("policies/travel.md", POLICY, { cause });
      const [event] = (await world.events()).filter((e) => e.type === "claims.updated");
      expect(event).toMatchObject({ causation_id: cause.id, correlation_id: "evt_01JC000000000000000000SYNC" });
    });

    test("an edit supersedes the claims whose sentences changed and keeps the rest", async ({ world }) => {
      const first = await world.version("travel-policy.md", POLICY);
      const claims = await world.store.getClaims(first.result.added);
      const id = (statement: string) => claims.find((c) => c.statement === statement)?.id;
      const edited: Para[] = [
        {
          ...(POLICY[0] as Para),
          text: "Hotels in tier-1 cities cost at most 650 yuan a night. The lodging standard in Chengdu and Hangzhou is 450 yuan a night. Hotel costs are reimbursed against invoices.",
        },
        { ...(POLICY[1] as Para), text: "Travel expense claims must be filed within 30 days after the trip." },
        POLICY[2] as Para,
        { id: "p4", heading: HEADING, text: "Staff pay for any hotel cost above the cap." },
      ];
      const { version, change, result } = await world.version("travel-policy.md", edited);
      expect(change.changed_block_ids).toHaveLength(2);
      expect(change.removed_span_ids).toHaveLength(2);

      const added = await world.store.getClaims(result.added);
      expect(added.map((c) => c.statement).sort()).toEqual([
        "Hotels in tier-1 cities cost at most 650 yuan a night.",
        "Staff pay for any hotel cost above the cap.",
      ]);
      const cap650 = added.find((c) => c.value?.number === 650)?.id;
      const paymentId = id("Approved reimbursements are paid every Wednesday.") as string;
      expect(result.superseded).toEqual([id("Hotels in tier-1 cities cost at most 600 yuan a night.")]);
      expect(result.unstated).toEqual([paymentId]);

      const [old600, payment] = await world.store.getClaims([
        id("Hotels in tier-1 cities cost at most 600 yuan a night.") as string,
        paymentId,
      ]);
      expect(old600).toMatchObject({ status: "superseded", superseded_by: cap650 });
      // No longer stated, and nothing replaces it: kept current, marked, until someone decides.
      expect(payment).toMatchObject({ status: "active", unstated: { source_version_id: version.id } });
      expect(payment?.superseded_at).toBeUndefined();

      const current = await world.store.asOf({ source_version_ids: [first.version.id, version.id] });
      expect(current.map((c) => c.statement).sort()).toEqual(
        [
          "Hotels in tier-1 cities cost at most 650 yuan a night.",
          "The lodging standard in Chengdu and Hangzhou is 450 yuan a night.",
          "Hotel costs are reimbursed against invoices.",
          "Travel expense claims must be filed within 30 days after the trip.",
          "Approved reimbursements are paid every Wednesday.",
          "Staff pay for any hotel cost above the cap.",
        ].sort(),
      );
      const event = claimsUpdated(await world.events()).at(-1);
      expect(event).toMatchObject({ added: result.added, updated: [paymentId], source_version_id: version.id });
      expect(event?.superseded).toEqual(result.superseded);
      // One todo for the document asks its owner to keep or retire what it stopped stating.
      expect(todoRequests(await world.events())).toEqual([
        expect.objectContaining({
          kind: "unstated",
          title: "travel-policy.md: 1 statement no longer stated",
          unit_ids: [paymentId],
          dedupe_key: `extraction:unstated:${version.source_id}:travel-policy.md`,
          priority: "normal",
        }),
      ]);
    });

    test("a dropped sentence that states no fact is retracted", async ({ world }) => {
      const keep = { id: "p1", text: "Staff pay for any hotel cost above the cap." };
      const v1 = await world.version("office.md", [keep, { id: "p2", text: "Desks must be kept tidy." }]);
      const v2 = await world.version("office.md", [keep]);
      const [desks] = await world.store.getClaims(v2.result.retracted);
      expect(desks).toMatchObject({ statement: "Desks must be kept tidy.", status: "retracted" });
      expect(v1.result.added).toContain(desks?.id);
      expect(v2.result.unstated).toEqual([]);
      expect(todoRequests(await world.events())).toEqual([]);
    });

    test("a statement no longer stated is restored when the document states it again", async ({ world }) => {
      const payday = { id: "p2", heading: HEADING, text: "Approved reimbursements are paid every Wednesday." };
      const hotel = { id: "p1", heading: HEADING, text: "Hotel costs are reimbursed against invoices." };
      const v1 = await world.version("travel.md", [hotel, payday]);
      const v2 = await world.version("travel.md", [hotel]);
      expect(v2.result.unstated).toHaveLength(1);
      expect(v1.result.added).toContain(v2.result.unstated[0]);
      // Delivered again, the version marks and asks nothing new.
      const before = (await world.events()).length;
      expect(await world.extraction.extract(v2.change)).toMatchObject({ added: [], superseded: [], restored: [] });
      expect((await world.events()).length).toBe(before);

      const v3 = await world.version("travel.md", [hotel, payday]);
      expect(v3.result).toMatchObject({ added: [], restored: v2.result.unstated, unstated: [] });
      const [back] = await world.store.getClaims(v2.result.unstated);
      expect(back?.unstated).toBeUndefined();
      expect(back?.superseded_at).toBeUndefined();
      expect(todoRequests(await world.events()).map((r) => [r.kind, r.withdrawn ?? false])).toEqual([
        ["unstated", false],
        ["unstated", true],
      ]);
    });

    test("a value the document states again after a gap supersedes the one it stopped stating", async ({ world }) => {
      const cap = (n: number) => ({
        id: "p1",
        heading: HEADING,
        text: `Hotels in tier-1 cities cost at most ${n} yuan a night.`,
      });
      const other = { id: "p2", heading: HEADING, text: "Hotel costs are reimbursed against invoices." };
      await world.version("travel.md", [cap(600), other]);
      const v2 = await world.version("travel.md", [other]);
      expect(v2.result.unstated).toHaveLength(1);
      const held = v2.result.unstated[0] as string;
      const v3 = await world.version("travel.md", [cap(650), other]);
      expect(v3.result.superseded).toEqual([held]);
      const [old, now] = await world.store.getClaims([held, v3.result.added[0] as string]);
      expect(old).toMatchObject({ status: "superseded", superseded_by: now?.id, value: { number: 600 } });
      expect(now?.value?.number).toBe(650);
      expect(todoRequests(await world.events()).at(-1)).toMatchObject({ kind: "unstated", withdrawn: true });
    });

    test("a fact stated twice is still stated when one place goes, and nobody is asked", async ({ world }) => {
      const cap = { id: "p1", heading: HEADING, text: "Hotels in tier-1 cities cost at most 600 yuan a night." };
      const summary = {
        id: "p9",
        heading: ["Travel policy", "Summary"],
        text: "In tier-1 cities, hotels cost at most 600 yuan a night.",
      };
      const v1 = await world.version("travel.md", [cap, summary]);
      const claims = await world.store.getClaims(v1.result.added);
      expect(claims).toHaveLength(2);
      expect(new Set(claims.map((c) => `${slotOf(c)}=${valueKeyOf(c)}`)).size).toBe(1);
      const left = claims.find((c) => c.statement === cap.text)?.id;
      const gone = claims.find((c) => c.statement === summary.text)?.id;

      const v2 = await world.version("travel.md", [cap]);
      expect(v2.result).toMatchObject({ added: [], superseded: [gone], unstated: [] });
      const [old] = await world.store.getClaims([gone as string]);
      expect(old).toMatchObject({ status: "superseded", superseded_by: left });
      expect(todoRequests(await world.events())).toEqual([]);
    });

    test("a renamed heading supersedes the claims read under the old one", async ({ world }) => {
      const under = (heading: string) => [
        { id: "p1", heading: ["Travel policy", heading], text: "Hotel costs are reimbursed against invoices." },
      ];
      const first = await world.version("travel.md", under("Beijing"));
      const second = await world.version("travel.md", under("Shanghai"));
      expect(second.change.changed_block_ids).toHaveLength(1);
      expect(second.result.superseded).toEqual(first.result.added);
      const versions = { source_version_ids: [first.version.id] }; // the spans never changed
      expect((await world.store.asOf(versions)).map((c) => c.subject_text)).toEqual(["Shanghai"]);
      // Renamed back, the first claim's statement is current again, as a new occurrence.
      const third = await world.version("travel.md", under("Beijing"));
      expect(third.result.added).toHaveLength(1);
      expect(third.result.added).not.toEqual(first.result.added);
      expect((await world.store.asOf(versions)).map((c) => c.subject_text)).toEqual(["Beijing"]);
    });

    test("a value changed back is current again, and the interval between keeps the other value", async ({ world }) => {
      const cap = (n: number) => [
        { id: "p1", heading: HEADING, text: `Hotels in tier-1 cities cost at most ${n} yuan a night.` },
      ];
      const v1 = await world.version("travel.md", cap(600));
      const v2 = await world.version("travel.md", cap(650));
      const v3 = await world.version("travel.md", cap(600));
      const [c600] = v1.result.added;
      const [c650] = v2.result.added;
      const [again] = v3.result.added;
      expect(again).toBeDefined();
      expect(again).not.toBe(c600);
      expect(v3.result.superseded).toEqual([c650]);
      const [first, second, third] = await world.store.getClaims([c600 as string, c650 as string, again as string]);
      expect(first).toMatchObject({ status: "superseded", superseded_by: c650 });
      expect(second).toMatchObject({ status: "superseded", superseded_by: again });
      expect(third).toMatchObject({ status: "active", value: { number: 600 } });
      expect(third?.superseded_at).toBeUndefined();
      // Known between the second and third versions: 650 only.
      const all = { source_version_ids: [v1.version.id, v2.version.id, v3.version.id] };
      const between = await world.store.asOf(all, { knownAt: new Date(first?.superseded_at as string) });
      expect(between.map((c) => c.value?.number)).toEqual([650]);

      // Extracting the third version again adds nothing; the first, delivered late, changes nothing.
      expect(await world.extraction.extract(v3.change)).toMatchObject({ added: [], superseded: [], unstated: [] });
      expect(await world.extraction.extract(v1.change)).toMatchObject({ added: [], outdated: true });
      expect((await world.store.asOf(all)).map((c) => [c.id, c.value?.number])).toEqual([[again, 600]]);
    });

    test("a deleted and restored document has its claims again", async ({ world }) => {
      const policy = [{ id: "p1", heading: HEADING, text: "Hotels in tier-1 cities cost at most 600 yuan a night." }];
      const v1 = await world.version("travel.md", policy);
      const gone = await world.version("travel.md", policy, { deleted: true });
      expect(gone.result.unstated).toEqual(v1.result.added);
      const back = await world.version("travel.md", policy);
      expect(back.result).toMatchObject({ added: [], restored: v1.result.added });
      const all = { source_version_ids: [v1.version.id, gone.version.id, back.version.id] };
      const claims = await world.store.asOf(all);
      expect(claims.map((c) => [c.value?.number, c.unstated])).toEqual([[600, undefined]]);
      expect(todoRequests(await world.events()).map((r) => [r.kind, r.withdrawn ?? false])).toEqual([
        ["source_deleted", false],
        ["source_deleted", true],
      ]);
    });

    test("a reworded sentence without a slot is superseded by the most similar one in its block", async ({ world }) => {
      const first = await world.version("meeting-rooms.md", [
        { id: "p1", text: "A meeting room is booked for at most 4 hours at a time and must be registered first." },
      ]);
      const second = await world.version("meeting-rooms.md", [
        { id: "p1", text: "A meeting room is booked for at most 3 hours at a time and must be registered first." },
      ]);
      expect(second.result.superseded).toEqual(first.result.added);
      expect(second.result.unstated).toEqual([]);
    });

    test("table rows become claims that cite their cells", async ({ world }) => {
      const { result } = await world.version("hotel-rates.csv", [
        { id: "t", kind: "table", text: "", header_rows: 1 },
        { id: "r0", kind: "table_row", table: "t", text: "City\tTier\tHotel cap (yuan/night)" },
        { id: "r1", kind: "table_row", table: "t", text: "Beijing\ttier-1 city\t600" },
        { id: "r2", kind: "table_row", table: "t", text: "Chengdu\tnew tier-1 city\t450" },
      ]);
      const claims = await world.store.getClaims(result.added);
      expect(claims.map((c) => [c.statement, c.qualifiers, c.value?.number]).sort()).toEqual([
        ["City: Beijing, Tier: tier-1 city, Hotel cap (yuan/night): 600.", ["tier-1 city"], 600],
        ["City: Chengdu, Tier: new tier-1 city, Hotel cap (yuan/night): 450.", ["new tier-1 city"], 450],
      ]);
      const evidence = await world.store.evidenceOf(result.added);
      expect(evidence.map((e) => e.quote).sort()).toEqual([
        "450",
        "600",
        "Beijing",
        "Chengdu",
        "new tier-1 city",
        "tier-1 city",
      ]);

      // A new header changes how every row reads: the rows' claims are restated.
      const edited = await world.version("hotel-rates.csv", [
        { id: "t", kind: "table", text: "", header_rows: 1 },
        { id: "r0", kind: "table_row", table: "t", text: "City\tTier\tHotel cap (yuan/night, tax included)" },
        { id: "r1", kind: "table_row", table: "t", text: "Beijing\ttier-1 city\t600" },
        { id: "r2", kind: "table_row", table: "t", text: "Chengdu\tnew tier-1 city\t450" },
      ]);
      expect(edited.change.changed_block_ids).toHaveLength(1);
      expect(edited.result.added).toHaveLength(2);
      expect(edited.result.superseded.sort()).toEqual([...result.added].sort());
    });

    test("a table row whose value changed supersedes its claim, though its other cells stay", async ({ world }) => {
      const rates = (beijing: number): Para[] => [
        { id: "t", kind: "table", text: "", header_rows: 1 },
        { id: "r0", kind: "table_row", table: "t", text: "City\tTier\tHotel cap (yuan/night)" },
        { id: "r1", kind: "table_row", table: "t", text: `Beijing\ttier-1 city\t${beijing}` },
        { id: "r2", kind: "table_row", table: "t", text: "Chengdu\tnew tier-1 city\t450" },
      ];
      const first = await world.version("hotel-rates.csv", rates(600));
      const old = (await world.store.getClaims(first.result.added)).find((c) => c.value?.number === 600)?.id;
      const second = await world.version("hotel-rates.csv", rates(650));
      expect(second.change.removed_span_ids).toHaveLength(1);
      expect(second.result).toMatchObject({ superseded: [old], unstated: [], retracted: [] });
      const [now] = await world.store.getClaims(second.result.added);
      expect(now?.value?.number).toBe(650);
      expect((await world.store.getClaims([old as string]))[0]).toMatchObject({
        status: "superseded",
        superseded_by: now?.id,
      });
      const all = { source_version_ids: [first.version.id, second.version.id] };
      expect((await world.store.asOf(all)).map((c) => c.value?.number).sort()).toEqual([450, 650]);
      expect(todoRequests(await world.events())).toEqual([]);
    });

    describe("a claim two sentences support, when one goes", () => {
      const cap = "Hotels in tier-1 cities cost at most 600 yuan a night.";
      const scope = "The cap applies to every trip.";
      const both = (world: World) => {
        const reply = JSON.stringify({
          claims: [
            {
              statement: "Hotels in tier-1 cities cost at most 600 yuan a night, on every trip.",
              claim_type: "rule",
              predicate: "hotel_cap_per_night",
              qualifiers: ["tier-1 cities"],
              value: { kind: "number", number: 600 },
              evidence: [
                { span: "s1", quote: cap },
                { span: "s2", quote: scope },
              ],
            },
          ],
        });
        for (const name of ["cloud", "local"])
          world.gateway.provider<FakeProvider>(name).script("extraction.extract_claims", reply);
      };

      test("stays while the other sentence is left untouched, and nobody is asked", async ({ world }) => {
        both(world);
        const first = await world.version("travel.md", [
          { id: "p1", heading: HEADING, text: cap },
          { id: "p2", heading: HEADING, text: scope },
        ]);
        expect(first.result.added).toHaveLength(1);
        const second = await world.version("travel.md", [{ id: "p1", heading: HEADING, text: cap }]);
        expect(second.change.removed_span_ids).toHaveLength(1);
        expect(second.result).toMatchObject({ added: [], superseded: [], retracted: [], unstated: [] });
        expect((await world.store.getClaims(first.result.added))[0]?.superseded_at).toBeUndefined();
        expect(todoRequests(await world.events())).toEqual([]);
      });

      test("is replaced by the same value when its passage is read again, and nobody is asked", async ({ world }) => {
        both(world);
        const first = await world.version("travel.md", [{ id: "p1", heading: HEADING, text: `${cap} ${scope}` }]);
        const second = await world.version("travel.md", [{ id: "p1", heading: HEADING, text: cap }]);
        expect(second.result).toMatchObject({ superseded: first.result.added, retracted: [], unstated: [] });
        const [now] = await world.store.getClaims(second.result.added);
        expect([slotOf(now as Claim), valueKeyOf(now as Claim)]).toEqual([
          "hotel_cap_per_night|tier-1 city",
          "600 CNY/night",
        ]);
        expect(todoRequests(await world.events())).toEqual([]);
      });
    });

    test("a deleted document keeps its claims, marked, and asks its owner once", async ({ world }) => {
      const first = await world.version("travel-policy.md", POLICY);
      const { version, result } = await world.version("travel-policy.md", [], { deleted: true });
      expect(result.windows).toBe(0);
      expect(result.unstated.sort()).toEqual([...first.result.added].sort());
      const kept = await world.store.asOf({ source_version_ids: [first.version.id] });
      expect(kept.map((c) => c.id).sort()).toEqual([...first.result.added].sort());
      for (const c of kept) expect(c.unstated).toMatchObject({ source_version_id: version.id, deleted: true });
      expect(todoRequests(await world.events())).toEqual([
        expect.objectContaining({
          kind: "source_deleted",
          title: "travel-policy.md was deleted: 5 statements kept",
          unit_ids: [...first.result.added].sort(),
        }),
      ]);
    });

    test("confidential documents are extracted by a model cleared for them", async ({ world }) => {
      await world.version("travel-policy.md", POLICY);
      await world.version("budget-2027.md", [{ id: "p1", text: "The R&D budget is capped at 12 million yuan." }], {
        sensitivity: "confidential",
      });
      expect(world.routed()).toEqual(["internal", "confidential"]);
      const claims = await world.store.asOf({});
      expect(claims.find((c) => c.statement.startsWith("The R&D budget"))?.sensitivity).toBe("confidential");
    });

    test("reading a document is charged to its space, never to a member", async ({ world }) => {
      const { version } = await world.version("travel-policy.md", POLICY);
      const ledger = (world.gateway.usage as MemoryUsage).records;
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.map((r) => [r.space_id, r.member_id])).toEqual(ledger.map(() => [version.space_id, undefined]));
    });

    test("claims without a verbatim quote are rejected", async ({ world }) => {
      const reply = JSON.stringify({
        claims: [
          {
            statement: "Hotel cap 600 yuan",
            claim_type: "rule",
            evidence: [{ span: "s1", quote: "600 yuan a night." }],
          },
          { statement: "A made-up rule", claim_type: "rule", evidence: [{ span: "s1", quote: "999 yuan a night" }] },
          { statement: "A passage that is not there", claim_type: "rule", evidence: [{ span: "s9", quote: "x" }] },
        ],
      });
      for (const name of ["cloud", "local"])
        world.gateway.provider<FakeProvider>(name).script("extraction.extract_claims", reply);
      const { result } = await world.version("travel-policy.md", [POLICY[0] as Para]);
      expect(result.rejected).toBe(2);
      expect((await world.store.getClaims(result.added)).map((c) => c.statement)).toEqual(["Hotel cap 600 yuan"]);
    });

    test("a model's catalogue fits are held to the catalogue, each value written one way", async ({ world }) => {
      const quote = "Hotels in tier-1 cities cost at most 600 yuan a night.";
      const claim = (statement: string, fit: object) => ({
        statement,
        claim_type: "rule",
        ...fit,
        evidence: [{ span: "s1", quote }],
      });
      const hotels = "hotel_cap_per_night";
      const reply = JSON.stringify({
        claims: [
          claim("A", { predicate: hotels, qualifiers: ["tier-1 cities"], value: { kind: "number", number: 600 } }),
          claim("B", { predicate: hotels, value: { kind: "money", unit: "CNY", normalized: "600 yuan/night" } }),
          claim("C", { predicate: "payment_day", value: { kind: "text", text: "Every wednesday" } }),
          claim("D", { predicate: hotels, qualifiers: ["coastal city"], value: { kind: "money", number: 600 } }),
          claim("E", { predicate: hotels, value: { kind: "money", number: 600, currency: "USD" } }),
          claim("F", { predicate: hotels, value: { kind: "money", text: "six hundred" } }),
          claim("G", { predicate: "payment_day", value: { kind: "enum", normalized: "every Monday" } }),
          claim("H", { predicate: "hotel_stays", value: { kind: "number", number: 600 } }),
        ],
      });
      for (const name of ["cloud", "local"])
        world.gateway.provider<FakeProvider>(name).script("extraction.extract_claims", reply);
      const { result } = await world.version("travel-policy.md", [POLICY[0] as Para]);
      expect(result.unfit).toBe(5);
      const claims = (await world.store.getClaims(result.added)).sort((a, b) => (a.statement < b.statement ? -1 : 1));
      expect(claims.map((c) => [c.statement, c.slot_key ?? null, c.value?.normalized ?? null])).toEqual([
        ["A", "hotel_cap_per_night|tier-1 city", "600 CNY/night"],
        ["B", "hotel_cap_per_night", "600 CNY/night"],
        ["C", "payment_day", "every Wednesday"],
        ["D", null, null],
        ["E", null, null],
        ["F", null, null],
        ["G", null, null],
        ["H", null, null],
      ]);
    });
  });
});
