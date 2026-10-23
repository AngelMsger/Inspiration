import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { Corpus, Engine, ingest } from "../src/index.ts";

const CORPUS = new URL("../../../examples/corpus/", import.meta.url).pathname;
const FINANCE = "grp_01QINGHE00000000000FINANCE";

interface Run {
  engine: Engine;
  corpus: Corpus;
  dir: string;
}

/** A copy of the demo corpus, so a test can edit it, and an engine over the given backend. */
async function open(stack?: { databaseUrl: string; streamPrefix: string }): Promise<Run & { close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-engine-"));
  await cp(CORPUS, join(dir, "corpus"), { recursive: true });
  const corpus = await Corpus.load(join(dir, "corpus"));
  const engine = await Engine.open({
    blobDir: join(dir, "blobs"),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  return {
    engine,
    corpus,
    dir: join(dir, "corpus"),
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function scenario({ engine, corpus, dir }: Run): Promise<void> {
  const first = await ingest(engine, corpus);
  expect(first.documents).toMatchObject({ total: 19, by_status: { parsed: 17, structured: 2 } });
  expect(first.documents.by_parser).toEqual({ markdown: 14, html: 1, csv: 1, text: 1 });
  expect(first.documents.by_governance).toMatchObject({ policy: 10, guideline: 3, reference: 3, note: 2, process: 1 });
  expect(first.events).toEqual({
    "document.fetched": 19,
    "acl.changed": 19,
    "blocks.changed": 19,
    "claims.updated": 19,
    "todo.requested": 3,
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

  // Every planted value conflict comes out as a slot with more than one value.
  expect(first.events["claims.updated"]).toBe(19);
  expect(first.claims).toMatchObject({ windows: 19, failed_windows: 0, rejected: 0, closed: 0 });
  expect(Object.fromEntries(first.claims.conflicts.top.map((t) => [t.slot, t.values]))).toEqual({
    "hotel_cap_per_night|一线城市": { "600 CNY/night": 7, "650 CNY/night": 3, "500 CNY/night": 1 },
    meal_allowance_per_day: { "100 CNY/day": 3, "80 CNY/day": 1 },
    "annual_leave_days|工龄 1 至 10 年": { "5 day": 1, "7 day": 1 },
    budget_draft_deadline: { "11 月 15 日": 1, "11 月 20 日": 1 },
  });

  // Governance settles the archived values alone and asks about the other three slots: the
  // notice and the meeting changed a value after the policy, and the guide contradicts one.
  expect(first.governance).toMatchObject({
    cases: { total: 5, by_class: { supersession: 4, contradiction: 1 }, by_status: { open: 3, auto_resolved: 2 } },
    todos: 3,
    todos_by_priority: { high: 2, normal: 1 },
    proposed_by: { changed: 2, authority: 2 },
    requests: 3,
  });
  const proposed = async (slot: string) =>
    (await engine.governance.slot(corpus.tenantId, slot)).decision?.proposed.value;
  expect(await proposed("hotel_cap_per_night|一线城市")).toBe("650 CNY/night");
  expect(await proposed("budget_draft_deadline")).toBe("11 月 20 日");
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
  const edited = await ingest(engine, corpus);
  // The header of the hotel table changed, so its three rows are read again and restated. They
  // state the same values, so governance asks for nothing new.
  expect(edited.events).toEqual({ "document.fetched": 1, "blocks.changed": 1, "claims.updated": 1 });
  expect(edited.governance).toMatchObject({ requests: 0, todos: 3 });
  expect(edited.claims).toMatchObject({ added: 3, closed: 3, windows: 1 });
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
