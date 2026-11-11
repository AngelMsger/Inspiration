import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderConnector } from "@inspiration/connectors";
import {
  type Connector,
  contentHash,
  type DocumentTreeNode,
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
import { assert, describe, expect, test, vi } from "vitest";
import { documentTree, pathParts, SourceSync, uploadAreaId } from "../src/index.ts";

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
    "both sync entry points share a job, persist results and preserve source configuration",
    async ({ world }) => {
      await world.write("policy.md", "Leave allowance: 20 days.");
      // Delay one list while another caller joins and source metadata changes.
      const implementation = FolderConnector.prototype.list;
      let release!: () => void;
      const blocked = new Promise<void>((done) => {
        release = done;
      });
      const slow = vi.spyOn(FolderConnector.prototype, "list").mockImplementation(async function (
        this: FolderConnector,
        scope,
        cursor,
      ) {
        await blocked;
        return implementation.call(this, scope, cursor);
      });
      try {
        const task = await world.sync.startSync(SOURCE);
        expect(task.source.sync?.state).toBe("running");
        const joined = world.sync.sync(SOURCE);
        const source = await world.sync.getSource(SOURCE);
        assert(source);
        await world.sync.addSource({ ...source, name: "Renamed during import" });
        release();
        expect(await joined).toEqual(await task.finished);
        expect(slow).toHaveBeenCalledTimes(1);
        expect(await world.sync.getSource(SOURCE)).toMatchObject({
          name: "Renamed during import",
          sync: { state: "succeeded", report: { outcomes: { created: 1 } } },
        });
        await world.sync.sync(SOURCE);
        expect((await world.sync.getSource(SOURCE))?.sync?.report?.outcomes.unchanged).toBe(1);
        const reopened = new SourceSync({ store: world.store, records: world.records, blobs: world.sync.blobs });
        expect((await reopened.getSource(SOURCE))?.sync?.state).toBe("succeeded");
        await reopened.addSource({ ...source, sync: { state: "running", started_at: new Date().toISOString() } });
        await reopened.recover();
        expect((await reopened.getSource(SOURCE))?.sync?.state).toBe("failed");
        expect((await reopened.sync(SOURCE)).outcomes.unchanged).toBe(1);
      } finally {
        release();
        slow.mockRestore();
        await world.sync.close();
      }
    },
  );

  it.skipIf(skip)(
    "the Documents tree folds a space's documents into folders, and builds none the reader cannot open",
    async ({ world }) => {
      await world.write("policies/finance/expenses.md", "# Expense policy\n\nArticle 1 The text.");
      await world.write("policies/finance/internal/budget.md", "# Budget note\n\nInternal.");
      await world.write("policies/leave.md", "# Leave policy\n\nFive days.");
      await world.write("notice.txt", "A company notice");
      await world.sync.sync(SOURCE);
      await world.remove("notice.txt");
      await world.sync.sync(SOURCE);

      const { sources, documents } = await world.sync.documents(TENANT, "spc_01JC00000000000000000SPACE");
      expect(documents.map((d) => d.entry.external_id).sort()).toEqual([
        "policies/finance/expenses.md",
        "policies/finance/internal/budget.md",
        "policies/leave.md",
      ]);
      const readable = documents.filter((d) => !d.entry.external_id.includes("/internal/"));
      const [root] = documentTree(sources, readable);
      const shape = (n: DocumentTreeNode): unknown =>
        n.kind === "document" ? n.name : { [n.name]: [n.document_count, ...(n.children ?? []).map(shape)] };
      expect(root && shape(root)).toEqual({
        Policies: [2, { policies: [2, { finance: [1, "Expense policy"] }, "Leave policy"] }],
      });
      expect(root?.children?.[0]?.children?.[0]?.path).toEqual(["policies", "finance"]);
      const leave = await world.sync.document(SOURCE, "policies/leave.md");
      expect(leave?.entry).toMatchObject({ title: "Leave policy", governance_level: "reference" });
      expect(leave?.entry.modified_at).toBeTruthy();
      expect(await world.sync.document(SOURCE, "notice.txt")).toBeUndefined();
    },
  );

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

  it.skipIf(skip)(
    "a file whose front matter stops being valid YAML fails alone and keeps the labels stored before",
    async ({ world }) => {
      // The folder's defaults are looser than the file's own labels, so reading the broken file
      // with the defaults would downgrade it from secret and bring a search-only draft into governance.
      await world.write("finance/.meta.yaml", "governance_level: governed\n");
      await world.write("finance/.acl.yaml", "readers: [group:finance]\n");
      const labels = "---\nsensitivity: secret\napproval_state: draft\ngovernance_level: search_only\n";
      const body = "---\n# Synthetic budget\nThe test amount is 123.\n";
      await world.write("finance/budget.md", `${labels}description: valid\n${body}`);
      await world.write("finance/notice.md", "# Notice\n\nFirst.");
      await world.sync.sync(SOURCE);
      const stored = async () => {
        const item = (await world.sync.items(SOURCE)).find((i) => i.external_id === "finance/budget.md");
        const version = await world.store.getSourceVersion(item?.source_version_id ?? "");
        return {
          id: version?.id,
          sensitivity: version?.sensitivity,
          approval_state: version?.approval_state,
          governance_level: version?.governance_level,
        };
      };
      const before = await stored();
      expect(before).toMatchObject({ sensitivity: "secret", approval_state: "draft", governance_level: "search_only" });

      await world.write("finance/budget.md", `${labels}description: "unterminated\n${body}`);
      await world.write("finance/notice.md", "# Notice\n\nSecond.");
      const report = await world.sync.sync(SOURCE);
      expect(report.outcomes).toMatchObject({ updated: 1, failed: 1, deleted: 0 });
      expect(report.errors).toEqual([
        { external_id: "finance/budget.md", error: expect.stringMatching(/^front matter is not valid YAML/) },
      ]);
      expect(await stored()).toEqual(before);
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

  it.skipIf(skip)(
    "an upload is a document at once; the same bytes change nothing, others make a version",
    async ({ world }) => {
      const space = "spc_01JC00000000000000000SPACE";
      const area = await world.sync.uploadArea(TENANT, space);
      expect(area).toMatchObject({ id: uploadAreaId(space), type: "upload", name: "Uploads" });
      expect((await world.sync.uploadArea(TENANT, space)).id).toBe(area.id);
      await expect(world.sync.uploadArea("ten_01JC00000000000000OTHER1", space)).rejects.toThrow(/another tenant/);
      const file = (text: string) => ({
        path: "policies/travel/Travel policy.md",
        bytes: new TextEncoder().encode(text),
        mime_type: "text/markdown",
        modified_at: "2026-11-04T09:12:00.000Z",
        uploaded_by: "mem_01JC00000000000000000ALICE",
      });

      const first = await world.sync.upload(area.id, file("# Travel\n\nEconomy class."));
      expect(first.changed).toBe(true);
      expect(first.document).toMatchObject({
        source_id: area.id,
        external_id: "policies/travel/Travel policy.md",
        title: "Travel policy",
        governance_level: "reference",
        mime_type: "text/markdown",
        modified_at: "2026-11-04T09:12:00.000Z",
      });
      const fetched = (await world.events()).filter((e) => e.type === "document.fetched");
      expect(fetched.map((e) => payloadOf(e, "document.fetched").needs_parsing)).toEqual([true]);
      const { sources, documents } = await world.sync.documents(TENANT, space);
      const tree = documentTree(
        sources.filter((s) => s.type === "upload"),
        documents.filter((d) => d.entry.source_id === area.id),
      );
      expect(tree[0]?.children?.[0]).toMatchObject({ name: "policies", path: ["policies"], document_count: 1 });

      const again = await world.sync.upload(area.id, file("# Travel\n\nEconomy class."));
      expect(again).toEqual({ document: first.document, changed: false });
      const next = await world.sync.upload(area.id, file("# Travel\n\nBusiness class."));
      expect(next.changed).toBe(true);
      expect(next.document.source_version_id).not.toBe(first.document.source_version_id);
      const version = await world.store.getSourceVersion(next.document.source_version_id);
      expect(version?.previous_version_id).toBe(first.document.source_version_id);
      expect((await world.sync.sync(area.id)).outcomes).toMatchObject({ unchanged: 1, created: 0, updated: 0 });
    },
  );

  it.skipIf(skip)(
    "an upload that failed after its record was written stores the file when retried",
    async ({ world }) => {
      const area = await world.sync.uploadArea(TENANT, "spc_01JC00000000000000000SPACE");
      const file = (text: string) => ({
        path: "Travel policy.md",
        bytes: new TextEncoder().encode(text),
        mime_type: "text/markdown",
        uploaded_by: "mem_01JC00000000000000000ALICE",
      });
      const first = await world.sync.upload(area.id, file("# Travel\n\nEconomy class."));
      vi.spyOn(world.store, "transaction").mockRejectedValueOnce(new Error("store went away"));
      await expect(world.sync.upload(area.id, file("# Travel\n\nBusiness class."))).rejects.toThrow(/went away/);

      const retried = await world.sync.upload(area.id, file("# Travel\n\nBusiness class."));
      expect(retried.changed).toBe(true);
      expect(retried.document.source_version_id).not.toBe(first.document.source_version_id);
      const version = await world.store.getSourceVersion(retried.document.source_version_id);
      expect(version).toMatchObject({
        previous_version_id: first.document.source_version_id,
        version: { content_hash: contentHash(new TextEncoder().encode("# Travel\n\nBusiness class.")) },
      });
      const fetched = (await world.events()).filter((e) => e.type === "document.fetched");
      expect(fetched.map((e) => payloadOf(e, "document.fetched").source_version_id)).toEqual([
        first.document.source_version_id,
        retried.document.source_version_id,
      ]);
      expect(await world.sync.upload(area.id, file("# Travel\n\nBusiness class."))).toEqual({
        document: retried.document,
        changed: false,
      });
    },
  );
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

test("a file path names every folder and the file, without . or .., control characters or backslashes", () => {
  expect(pathParts("a/b/c.md")).toEqual({ folders: ["a", "b"], name: "c.md" });
  expect(pathParts("c.md")).toEqual({ folders: [], name: "c.md" });
  for (const bad of ["", "/c.md", "a//c.md", "a/", "./c.md", "a/../c.md", "a\\c.md", "a/c\u0007.md"]) {
    expect(() => pathParts(bad), bad).toThrow(RangeError);
  }
  expect(() => pathParts(`${"a/".repeat(512)}c.md`)).toThrow(/1024 characters/);
});
