import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Corpus, Engine } from "@inspiration/engine";
import { hasStack, stackTest, testData, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { days, inboxReport, ingest, SimulatedClock } from "../src/index.ts";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus/", import.meta.url));
const FINANCE = "grp_01HENGYUAN000000000FINANCE";

/** What the run finds, in the corpus's own words (test/data/corpus.yaml). */
const FOUND = testData<{
  duplicates: [string, string, boolean][];
  conflicts: Record<string, Record<string, number>>;
  proposed: Record<string, string>;
  topics: [string, number][];
  cards: [string, string[]][];
  confidential: string;
  edit: { path: string[]; from: string; to: string };
}>(import.meta.url, "corpus.yaml");

interface Run {
  engine: Engine;
  corpus: Corpus;
  dir: string;
  clock: SimulatedClock;
}

/** A copy of the demo corpus, so a test can edit it, and an engine over the given backend. */
async function open(stack?: { databaseUrl: string; streamPrefix: string }): Promise<Run & { close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-bench-"));
  // Each ingest gives the files the days files.yaml records, so review clocks do not depend on
  // the checkout.
  await cp(CORPUS, join(dir, "corpus"), { recursive: true });
  const corpus = await Corpus.load(join(dir, "corpus"));
  const clock = new SimulatedClock(new Date("2026-10-23T09:00:00Z"));
  const engine = await Engine.open({
    clock: clock.now,
    blobDir: join(dir, "blobs"),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  return {
    engine,
    corpus,
    clock,
    dir: join(dir, "corpus"),
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function scenario({ engine, corpus, dir, clock }: Run): Promise<void> {
  const first = await ingest(engine, corpus);
  expect(first.documents).toMatchObject({ total: 38, by_status: { parsed: 36, structured: 2 } });
  expect(first.documents.by_parser).toEqual({ markdown: 33, html: 1, csv: 1, text: 1 });
  expect(first.documents.by_level).toEqual({ governed: 28, reference: 9, search_only: 1 });
  // The weekly report is search only, and one reference document gives no window to read, so
  // neither updates claims.
  expect(first.events).toEqual({
    "document.fetched": 38,
    "acl.changed": 38,
    "blocks.changed": 38,
    "claims.updated": 36,
    // Three conflicts and a note: the price list charges more than the travel policy allows, the
    // minutes moved the budget deadline after the budget note, the guide contradicts the leave
    // policy, and the loan FAQ gives an old settlement period.
    "todo.requested": 4,
  });
  expect(first.dead_letters).toBe(0);
  expect(first.acl.unmapped).toEqual([]);
  // The copy forwarded to HR is exact. The 2023 edition differs too much to count as a copy.
  expect(first.duplicates.map((d) => [d.document, d.duplicate_of, d.exact]).sort()).toEqual(FOUND.duplicates);
  expect(first.blocks.by_kind).toMatchObject({ table: 11, form_field: 4 });

  // Every planted value conflict comes out as a slot with more than one value, reference
  // documents included: they are read where they name a catalogue fact, and their claims
  // outside any slot are left unused.
  expect(first.claims).toMatchObject({ windows: 36, failed_windows: 0, rejected: 0, unused: 11, closed: 0 });
  expect(first.claims.by_level).toMatchObject({
    governed: { documents: 28, windows: 28 },
    reference: { documents: 9, windows: 8 },
    search_only: { documents: 1, claims: 0, windows: 0 },
  });
  expect(Object.fromEntries(first.claims.conflicts.top.map((t) => [t.slot, t.values]))).toEqual(FOUND.conflicts);

  // Governance settles the archived values alone and asks about three slots: the price list,
  // newer than the travel policy, charges 650 a night where the policy allows 600; the meeting
  // minutes moved the budget deadline after the budget note; and the guide contradicts the
  // leave policy. The minutes are a reference document, but their decision is dated and in
  // effect, so it holds until the note's owner updates it or rejects it. The loan FAQ, older
  // than the loan policy, gets a note instead of a question.
  expect(first.governance).toMatchObject({
    cases: { total: 6, by_class: { supersession: 3, contradiction: 3 }, by_status: { open: 3, auto_resolved: 3 } },
    todos: 3,
    todos_by_priority: { high: 3 },
    proposed_by: { changed: 1, authority: 4 },
    requests: 3,
    notes: 1,
    withdrawn: 0,
  });
  // Only the 28 governed documents keep review clocks. Policies are reviewed yearly and
  // processes every 180 days; the archive and general notes never by age. Two of them have
  // gone unchanged past their review date, by the days files.yaml records.
  expect(first.freshness).toMatchObject({
    documents: 28,
    by_review_class: { policy: 20, process: 3 },
    never_due: { dated: 0, archived: 1, no_interval: 4 },
    overdue: 2,
    states: { fresh: 16, aging: 9, stale: 2 },
    reviews: {},
  });
  // page-compiler clusters the 69 sections of current governed documents into topics: those
  // that share a heading across documents (lodging, transport, reimbursement), and what is left
  // of a document when it holds five statements or more. The small documents stay unfiled, and
  // reference statements of a slot join the slot's topic. Clustering again with nothing
  // changed moves nothing.
  expect(first.outline.run).toMatchObject({
    sections: 69,
    statements: 142,
    placed: { governed: 98, reference: 14, search_only: 0 },
    unfiled: 44,
    topics: { live: 18, by_level: { "1": 2, "2": 16, "3": 0 }, created: 18, retired: 0 },
    churn: { before: 0, moved: 0 },
    // Topics are named in one call per sensitivity, the confidential budget guide's apart, and
    // the area after them.
    model_calls: 3,
  });
  expect(first.outline.again).toMatchObject({ churn: { before: 98, moved: 0, deferred: 0 }, topics: { created: 0 } });
  const outline = await engine.store.topics(corpus.tenantId);
  expect(outline.map((n) => [n.title, n.statement_count]).sort()).toEqual(FOUND.topics);
  // Each topic's owner is the member who wrote most of its documents. The inbox puts the three
  // conflicts and the note on their owners' cards; nothing waits.
  expect(first.owners).toMatchObject({ topics: 18, owned: 16, assigned: 16, owners: 7, rerouted: 4 });
  expect(first.inbox).toMatchObject({
    todos: 4,
    open: 4,
    withdrawn: 0,
    by_kind: { conflict: 3, note: 1 },
    owners: 4,
    cards: { total: 3, over_budget: 0 },
    deferred: { todos: 0 },
    notes: { total: 1 },
    campaign: { todos: 0 },
    steward: { todos: 0 },
  });
  const cards = await engine.inbox.cards(corpus.tenantId);
  expect(cards.map((c) => [c.kind, c.todos.map((t) => t.title)])).toEqual(FOUND.cards);
  for (const [slot, value] of Object.entries(FOUND.proposed)) {
    expect((await engine.governance.slot(corpus.tenantId, slot)).decision?.proposed.value, slot).toBe(value);
  }

  // The finance-only folder keeps its group, mapped through the directory.
  const [budget] = (await engine.sync.items(corpus.sources[0]?.id as string)).filter((i) =>
    i.external_id.startsWith(FOUND.confidential),
  );
  const version = await engine.store.getSourceVersion(budget?.source_version_id as string);
  expect(version?.sensitivity).toBe("confidential");
  const acl = await engine.store.getAclSnapshot(
    version?.source_id as string,
    version?.external_id as string,
    version?.version.acl_hash as string,
  );
  expect(acl?.entries.filter((e) => e.role === "viewer").map((e) => e.principal_id)).toEqual([FINANCE]);

  // Nothing changed: the second run fetches and normalizes nothing.
  const again = await ingest(engine, corpus);
  expect(again.events).toEqual({});
  expect(again.sources.every((s) => s.outcomes.unchanged === s.items)).toBe(true);

  // An edit to one article is one changed block downstream.
  const path = join(dir, ...FOUND.edit.path);
  await writeFile(path, (await readFile(path, "utf8")).replace(FOUND.edit.from, FOUND.edit.to));
  const edited = await ingest(engine, corpus);
  // The header of the hotel table changed, so its three rows are read again and restated. They
  // state the same values, so governance asks for nothing new; the open hotel question is sent
  // again with the restated claims. The forwarded copy no longer matches the policy, but it is
  // a reference document: nobody owns its review, so freshness asks for nothing. The archived
  // edition is left alone.
  expect(edited.events).toEqual({
    "document.fetched": 1,
    "blocks.changed": 1,
    "claims.updated": 1,
    "todo.requested": 1,
  });
  expect(edited.governance).toMatchObject({ requests: 0, todos: 3 });
  expect(edited.claims).toMatchObject({ added: 3, closed: 3, windows: 1 });
  expect(edited.freshness).toMatchObject({
    reviews: {},
    edits: 1,
    edits_with_reviews: 0,
    states: { fresh: 16, aging: 9, stale: 2 },
  });
  expect(edited.asks).toEqual({ updates: 1, asking: 0, per_update: { median: 0, p90: 0, max: 0 } });
  // The restated rows took their section's place in the outline at once.
  expect(edited.outline.run).toMatchObject({ placed: { governed: 99 }, churn: { before: 99, moved: 0 } });

  // Over the next sixty days the two overdue documents come due on the first day, as a
  // first-review campaign, four more come due by age, and one rests on an assumption that has
  // drifted.
  const later = await days(engine, corpus.tenantId, clock, 60);
  expect(later).toMatchObject({ backlog: { ttl: 2 }, reviews: { assumption: 1, ttl: 4 }, rechecked_slots: 0 });
  expect(await inboxReport(engine, corpus.tenantId)).toMatchObject({
    open: 11,
    by_kind: { conflict: 3, note: 1, review_due: 6, assumption_drift: 1 },
  });
}

describe("ingesting the demo corpus", () => {
  test("in memory", async () => {
    const run = await open();
    try {
      await scenario(run);
    } finally {
      await run.close();
    }
  });

  describe.skipIf(!hasStack())("on the stack", () => {
    stackTest("Postgres with the outbox relayed to Valkey Streams", async ({ databaseUrl, streamPrefix, valkey }) => {
      expect(valkey).toBeDefined(); // removes this run's stream keys afterwards
      const run = await open({ databaseUrl, streamPrefix });
      try {
        await scenario(run);
      } finally {
        await run.close();
      }
    });
  });
});
