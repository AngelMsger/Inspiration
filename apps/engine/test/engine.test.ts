import { cp, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { Corpus, days, Engine, ingest, SimulatedClock } from "../src/index.ts";

const CORPUS = new URL("../../../examples/corpus/", import.meta.url).pathname;
const FINANCE = "grp_01QINGHE00000000000FINANCE";

interface Run {
  engine: Engine;
  corpus: Corpus;
  dir: string;
  clock: SimulatedClock;
}

/** Set a file's modification time, which the folder connector reports as when it last changed. */
async function touch(path: string, day: string): Promise<void> {
  const at = new Date(`${day}T08:00:00Z`);
  await utimes(path, at, at);
}

/** A copy of the demo corpus, so a test can edit it, and an engine over the given backend. */
async function open(stack?: { databaseUrl: string; streamPrefix: string }): Promise<Run & { close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-engine-"));
  await cp(CORPUS, join(dir, "corpus"), { recursive: true });
  // Every document last changed on one day, so review clocks do not depend on the checkout.
  for (const file of await readdir(join(dir, "corpus"), { recursive: true })) {
    if (file.endsWith(".md") || file.endsWith(".html") || file.endsWith(".csv") || file.endsWith(".txt"))
      await touch(join(dir, "corpus", file), "2026-06-01");
  }
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
  expect(first.documents).toMatchObject({ total: 19, by_status: { parsed: 17, structured: 2 } });
  expect(first.documents.by_parser).toEqual({ markdown: 14, html: 1, csv: 1, text: 1 });
  expect(first.documents.by_level).toEqual({ governed: 14, reference: 4, search_only: 1 });
  // The weekly report is search only: nothing is extracted from it, so it updates no claims.
  expect(first.events).toEqual({
    "document.fetched": 19,
    "acl.changed": 19,
    "blocks.changed": 19,
    "claims.updated": 18,
    "todo.requested": 2,
  });
  expect(first.dead_letters).toBe(0);
  expect(first.acl.unmapped).toEqual([]);
  // The forwarded copy is exact; the 2023 edition is near both the policy and its copy.
  expect(first.duplicates.map((d) => [d.document, d.duplicate_of, d.exact]).sort()).toEqual([
    ["制度库/财务/差旅费管理办法.md", "制度库/人事/转发-差旅费管理办法.md", true],
    ["归档/差旅费管理办法（2023 版）.md", "制度库/人事/转发-差旅费管理办法.md", false],
    ["归档/差旅费管理办法（2023 版）.md", "制度库/财务/差旅费管理办法.md", false],
  ]);
  expect(first.blocks.by_kind).toMatchObject({ table: 9, form_field: 4 });

  // Every planted value conflict comes out as a slot with more than one value, reference
  // documents included: they are read where they name a catalogue fact, and their claims
  // outside any slot are left unused.
  expect(first.claims).toMatchObject({ windows: 18, failed_windows: 0, rejected: 0, unused: 8, closed: 0 });
  expect(first.claims.by_level).toMatchObject({
    governed: { documents: 14, windows: 14 },
    reference: { documents: 4, windows: 4 },
    search_only: { documents: 1, claims: 0, windows: 0 },
  });
  expect(Object.fromEntries(first.claims.conflicts.top.map((t) => [t.slot, t.values]))).toEqual({
    "hotel_cap_per_night|一线城市": { "600 CNY/night": 7, "650 CNY/night": 3, "500 CNY/night": 1 },
    meal_allowance_per_day: { "100 CNY/day": 3, "80 CNY/day": 1 },
    "annual_leave_days|工龄 1 至 10 年": { "5 day": 1, "7 day": 1 },
    budget_draft_deadline: { "11 月 15 日": 1, "11 月 20 日": 1 },
  });

  // Governance settles the archived values alone and asks about two slots: the notice changed
  // a value after the policy, and the guide contradicts one. The meeting minutes are a
  // reference document, so the deadline they moved is a note for the owner, not a todo; the
  // FAQ's 650 was a note too until the notice made it the governed value.
  expect(first.governance).toMatchObject({
    cases: { total: 6, by_class: { supersession: 3, contradiction: 3 }, by_status: { open: 2, auto_resolved: 4 } },
    todos: 2,
    todos_by_priority: { high: 1, normal: 1 },
    proposed_by: { changed: 1, authority: 3 },
    requests: 2,
  });
  // Only the 14 governed documents keep review clocks. Policies are reviewed yearly and
  // processes every 180 days; the archive and general notes never by age. Nothing is due
  // yet; the process documents are aging.
  expect(first.freshness).toMatchObject({
    documents: 14,
    by_review_class: { policy: 8, process: 3 },
    never_due: { dated: 0, archived: 1, no_interval: 2 },
    overdue: 0,
    states: { fresh: 10, aging: 3 },
    reviews: {},
  });
  const proposed = async (slot: string) =>
    (await engine.governance.slot(corpus.tenantId, slot)).decision?.proposed.value;
  expect(await proposed("hotel_cap_per_night|一线城市")).toBe("650 CNY/night");
  expect(await proposed("budget_draft_deadline")).toBe("11 月 15 日");
  expect(await proposed("annual_leave_days|工龄 1 至 10 年")).toBe("5 day");
  expect(await proposed("meal_allowance_per_day")).toBe("100 CNY/day");

  // The finance-only folder keeps its group, mapped through the directory.
  const [budget] = (await engine.sync.items(corpus.sources[0]?.id as string)).filter((i) =>
    i.external_id.startsWith("财务/内部/"),
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
  const path = join(dir, "制度库", "财务", "差旅费管理办法.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("每晚限额（元） |", "每晚限额（元，含税） |"));
  await touch(path, "2026-10-23");
  const edited = await ingest(engine, corpus);
  // The header of the hotel table changed, so its three rows are read again and restated. They
  // state the same values, so governance asks for nothing new. The forwarded copy no longer
  // matches the policy, but it is a reference document: nobody owns its review, so freshness
  // asks for nothing. The archived edition is left alone.
  expect(edited.events).toEqual({
    "document.fetched": 1,
    "blocks.changed": 1,
    "claims.updated": 1,
  });
  expect(edited.governance).toMatchObject({ requests: 0, todos: 2 });
  expect(edited.claims).toMatchObject({ added: 3, closed: 3, windows: 1 });
  expect(edited.freshness).toMatchObject({
    reviews: {},
    edits: 1,
    edits_with_reviews: 0,
    states: { fresh: 10, aging: 3 },
  });
  expect(edited.asks).toEqual({ updates: 1, asking: 0, per_update: { median: 0, p90: 0, max: 0 } });

  // Over the next sixty days the three process documents come due.
  const later = await days(engine, corpus.tenantId, clock, 60);
  expect(later).toMatchObject({ backlog: {}, reviews: { ttl: 3 }, rechecked_slots: 0 });
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
