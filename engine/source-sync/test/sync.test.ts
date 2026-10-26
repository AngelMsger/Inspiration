import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderConnector } from "@inspiration/connectors";
import {
  type Connector,
  type EventEnvelope,
  type KnowledgeStore,
  type NormalizedDocument,
  newEvent,
  payloadOf,
  type Source,
} from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { LocalBlobStore, openPool } from "@inspiration/kernel";
import { MemoryStore, PostgresStore } from "@inspiration/knowledge-store";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { SourceSync } from "../src/index.ts";

const TENANT = "ten_01JC0000000000000000TENANT";
const FINANCE = "grp_01JC0000000000000FINANCE1";

function folderSource(root: string): Source {
  return {
    id: "src_01JC0000000000000000FOLDER",
    tenant_id: TENANT,
    space_id: "spc_01JC00000000000000000SPACE",
    type: "folder",
    name: "Policies",
    scope: { kind: "folder", options: { root } },
    status: "active",
    default_sensitivity: "internal",
    default_authority: 0.8,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

type Backend = "memory" | "postgres";

interface World {
  dir: string;
  store: KnowledgeStore;
  records: Records;
  sync: SourceSync;
  events: () => Promise<EventEnvelope[]>;
  write: (path: string, text: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

const syncTest = (backend: Backend) =>
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
  test.extend("world", async ({}, { onCleanup }): Promise<World> => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-sync-"));
    const cleanups: (() => Promise<unknown>)[] = [() => rm(dir, { recursive: true, force: true })];
    onCleanup(async () => {
      for (const c of cleanups.reverse()) await c();
    });
    let store: MemoryStore | PostgresStore;
    let records: Records;
    let events: () => Promise<EventEnvelope[]>;
    if (backend === "memory") {
      const memory = new MemoryStore();
      store = memory;
      records = new MemoryRecords();
      events = async () => [...memory.published];
    } else {
      const db = await createTestDatabase();
      const pool = await openPool(db.url);
      cleanups.push(async () => {
        await pool.end();
        await db.drop();
      });
      store = new PostgresStore(pool);
      records = new PgRecords(pool);
      events = async () =>
        (await pool.query<{ envelope: EventEnvelope }>("SELECT envelope FROM bus.outbox ORDER BY seq")).rows.map(
          (r) => r.envelope,
        );
    }
    const sync = new SourceSync({
      store,
      records,
      blobs: new LocalBlobStore(join(dir, "blobs")),
      resolvePrincipal: (_source, entry) => (entry.external_id === "finance" ? FINANCE : undefined),
    });
    const corpus = join(dir, "corpus");
    await sync.addSource(folderSource(corpus));
    const write = async (path: string, text: string) => {
      const parts = path.split("/");
      await mkdir(join(corpus, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(corpus, ...parts), text);
    };
    return { dir, store, records, sync, events, write, remove: (path) => rm(join(corpus, ...path.split("/"))) };
  });

const SOURCE = "src_01JC0000000000000000FOLDER";

describe.each<{ backend: Backend; skip: boolean }>([
  { backend: "memory", skip: false },
  { backend: "postgres", skip: !hasStack() },
])("source sync on $backend", ({ backend, skip }) => {
  const it = syncTest(backend);

  it.skipIf(skip)(
    "each version gets its governance level: the item's, its folder's, else reference",
    async ({ world }) => {
      await world.write("policies/.meta.yaml", "governance_level: governed\n");
      await world.write("policies/expenses.md", "# Expense policy\n\nArticle 1 The text.");
      await world.write("policies/draft.md", "---\ngovernance_level: search_only\n---\n# Draft\n\nNot final.");
      await world.write("notice.txt", "A company notice");
      await world.sync.sync(SOURCE);
      const levels: Record<string, string | undefined> = {};
      for (const e of await world.events()) {
        if (e.type !== "document.fetched") continue;
        const fetched = payloadOf(e, "document.fetched");
        levels[fetched.external_id] = (await world.store.getSourceVersion(fetched.source_version_id))?.governance_level;
      }
      expect(levels).toEqual({
        "policies/expenses.md": "governed",
        "policies/draft.md": "search_only",
        "notice.txt": "reference",
      });
    },
  );

  it.skipIf(skip)("a first sync stores versions, ACL snapshots and events", async ({ world }) => {
    await world.write("finance/.acl.yaml", "readers: [group:finance, group:unknown]\n");
    await world.write(
      "finance/expenses.md",
      "---\napproval_state: approved\n---\n# Expense policy\n\nArticle 1 The text.",
    );
    await world.write("notice.txt", "A company notice");
    const report = await world.sync.sync(SOURCE);
    expect(report.outcomes).toMatchObject({ created: 2, unchanged: 0, failed: 0 });

    const events = await world.events();
    expect(events.map((e) => e.type)).toEqual(["document.fetched", "acl.changed", "document.fetched", "acl.changed"]);
    const fetched = payloadOf(events[0] as EventEnvelope, "document.fetched");
    expect(fetched).toMatchObject({ external_id: "finance/expenses.md", deleted: false, needs_parsing: true });
    expect(fetched.changed).toEqual({ content: true, metadata: true, acl: true });

    const version = await world.store.getSourceVersion(fetched.source_version_id);
    expect(version).toMatchObject({
      title: "Expense policy",
      approval_state: "approved",
      authority: 0.8,
      sensitivity: "internal",
      mime_type: "text/markdown",
    });
    expect(version?.blob?.mime_type).toBe("application/vnd.inspiration.document+json");

    const acl = payloadOf(events[1] as EventEnvelope, "acl.changed");
    expect(acl.space_id).toBe("spc_01JC00000000000000000SPACE");
    expect(acl.snapshot?.entries).toEqual([
      { principal_kind: "group", external_id: "finance", principal_id: FINANCE, role: "viewer" },
      { principal_kind: "group", external_id: "unknown", role: "viewer" },
    ]);
    expect(await world.store.getAclSnapshot(SOURCE, "finance/expenses.md", acl.acl_hash)).toEqual(acl.snapshot);

    // Nothing changed: nothing is fetched or published.
    const again = await world.sync.sync(SOURCE);
    expect(again.outcomes).toMatchObject({ unchanged: 2, created: 0, updated: 0 });
    expect(await world.events()).toHaveLength(4);
  });

  it.skipIf(skip)("edits make new versions; ACL changes alone do not", async ({ world }) => {
    await world.write("a.md", "# A\n\nThe first version.");
    await world.sync.sync(SOURCE);
    const [first] = await world.sync.items(SOURCE);

    await world.write("a.md", "# A\n\nThe second version.");
    expect((await world.sync.sync(SOURCE)).outcomes.updated).toBe(1);
    const [second] = await world.sync.items(SOURCE);
    expect(second?.source_version_id).not.toBe(first?.source_version_id);
    const v2 = await world.store.getSourceVersion(second?.source_version_id as string);
    expect(v2?.previous_version_id).toBe(first?.source_version_id);

    await world.write(".acl.yaml", "readers: [tenant]\n");
    expect((await world.sync.sync(SOURCE)).outcomes.acl_changed).toBe(1);
    const [third] = await world.sync.items(SOURCE);
    expect(third?.source_version_id).toBe(second?.source_version_id);
    const last = (await world.events()).at(-1) as EventEnvelope;
    expect(last.type).toBe("acl.changed");
    expect(payloadOf(last, "acl.changed").source_version_id).toBe(second?.source_version_id);
  });

  it.skipIf(skip)("items gone from the source get a tombstone", async ({ world }) => {
    await world.write("a.md", "# A");
    await world.write("b.md", "# B");
    await world.sync.sync(SOURCE);
    await world.remove("b.md");
    expect((await world.sync.sync(SOURCE)).outcomes.deleted).toBe(1);
    const b = (await world.sync.items(SOURCE)).find((i) => i.external_id === "b.md");
    expect(b?.deleted).toBe(true);
    const tomb = await world.store.getSourceVersion(b?.source_version_id as string);
    expect(tomb?.deleted).toBe(true);
    expect(tomb?.title).toBe("B");
    const last = payloadOf((await world.events()).at(-1) as EventEnvelope, "document.fetched");
    expect(last).toMatchObject({ external_id: "b.md", deleted: true });
    // A tombstone is written once; the file coming back is a new item version.
    expect((await world.sync.sync(SOURCE)).outcomes.deleted).toBe(0);
    await world.write("b.md", "# B");
    expect((await world.sync.sync(SOURCE)).outcomes.created).toBe(1);
  });

  it.skipIf(skip)("source.changed syncs the one item", async ({ world }) => {
    await world.write("a.md", "# A");
    await world.write("b.md", "# B");
    const ref = { source_id: SOURCE, external_id: "b.md" };
    const changed = (kind: "updated" | "deleted") =>
      newEvent(
        "source.changed",
        { source_id: SOURCE, change: { ref, kind, observed_at: new Date().toISOString(), via: "webhook" } },
        { tenantId: TENANT, producer: "connectors" },
      );
    await world.sync.onSourceChanged(changed("updated"));
    expect((await world.sync.items(SOURCE)).map((i) => i.external_id)).toEqual(["b.md"]);
    await world.sync.onSourceChanged(changed("deleted"));
    expect((await world.sync.items(SOURCE))[0]?.deleted).toBe(true);
  });
});

test("one failing item does not stop the others", async () => {
  const store = new MemoryStore();
  const dir = await mkdtemp(join(tmpdir(), "inspiration-sync-"));
  try {
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    const folder = new FolderConnector(folderSource(dir), { blobs, secret: async () => "" });
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "b.md"), "# B");
    const flaky: Connector = {
      type: "folder",
      capabilities: () => folder.capabilities(),
      list: (scope, cursor) => folder.list(scope, cursor),
      fetch: async (ref, known) => {
        if (ref.external_id === "a.md") throw new Error("rate limited");
        return folder.fetch(ref, known) as Promise<NormalizedDocument>;
      },
    };
    const sync = new SourceSync({ store, records: new MemoryRecords(), blobs, connector: async () => () => flaky });
    await sync.addSource(folderSource(dir));
    const report = await sync.sync(SOURCE);
    expect(report.outcomes).toMatchObject({ created: 1, failed: 1 });
    expect(report.errors).toEqual([{ external_id: "a.md", error: "rate limited" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
