import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEvent, type Principal, type Source } from "@inspiration/contracts";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { connectionSecret, connections, connectSource, startSync } from "../src/connections.ts";
import { Engine } from "../src/engine.ts";
import { organizeKnowledge } from "../src/organization.ts";
import { syncNow } from "../src/spaces.ts";

const TENANT = "ten_00000000LOCAL";
const MEMBER = "mem_00000000OWNER";
const who: Principal = { id: MEMBER, tenant_id: TENANT, kind: "member" };
let dir: string;
let engine: Engine;
let upstream: Server;
let space: string;
let amount = 20;
let status = 200;
let small = false;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-connections-"));
  amount = 20;
  status = 200;
  small = false;
  upstream = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        results: [
          {
            id: "12",
            title: "Leave",
            version: { number: amount, when: "2026-11-01T00:00:00Z" },
            body: {
              view: {
                value: small
                  ? `<p>Leave allowance: ${amount} days.</p>`
                  : `<p>Leave allowance: ${amount} days.</p><p>Meal allowance: 40 credits.</p><p>Training allowance: 100 credits.</p><p>Notice period: 30 days.</p><p>Trial period: 90 days.</p>`,
              },
            },
            ancestors: [],
          },
        ],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  vi.stubEnv("INSPIRATION_LOCAL_CONNECTIONS", "1");
  vi.stubEnv("INSPIRATION_CONFLUENCE_URL", `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  vi.stubEnv("INSPIRATION_CONFLUENCE_TOKEN", randomBytes(24).toString("hex"));
  await openEngine();
});
afterEach(async () => {
  await engine?.close();
  upstream?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function openEngine(discoverFacts = true) {
  engine = await Engine.open({ blobDir: dir, secret: connectionSecret, discoverFacts, readOnUse: true });
  await engine.directory.putTenant(
    TENANT,
    { name: "Local", kind: "team", default_locale: "en", version: 1 },
    "svc_00000000LOCAL",
  );
  await engine.directory.putMember(TENANT, MEMBER, {
    display_name: "Owner",
    status: "active",
    roles: ["admin", "owner"],
    version: 1,
  });
  const created = await engine.directory.createSpace(
    TENANT,
    { name: "Policies", owner_ids: [MEMBER] },
    { idempotencyKey: "local-space" },
  );
  space = created.space.id;
}

async function finished(id: string): Promise<Source> {
  await expect.poll(async () => (await engine.sync.getSource(id))?.sync?.state).not.toBe("running");
  await engine.settle();
  const source = await engine.sync.getSource(id);
  if (!source) throw new Error("source disappeared");
  return source;
}

test("a fresh company connects, syncs, cites, updates and retries without losing its previous version", async () => {
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "governed",
  });
  await startSync(engine, who, source.id);
  const first = await finished(source.id);
  expect(first.sync?.report?.outcomes.created).toBe(1);
  const imported = await engine.sync.documents(TENANT, space);
  expect(imported.documents[0]?.entry.url).toBe(
    `${process.env.INSPIRATION_CONFLUENCE_URL}/pages/viewpage.action?pageId=12`,
  );
  await organizeKnowledge(engine, TENANT);
  const answer = await engine.compact.answer({ question: "What is the leave allowance?" }, who);
  expect(JSON.stringify(answer)).toContain("20");
  const topics = await engine.store.topics(TENANT);
  expect(topics.length).toBeGreaterThan(0);
  expect(topics.every((t) => t.owner_id === MEMBER)).toBe(true);
  await startSync(engine, who, source.id);
  expect((await finished(source.id)).sync?.report?.outcomes.unchanged).toBe(1);
  amount = 25;
  await startSync(engine, who, source.id);
  expect((await finished(source.id)).sync?.report?.outcomes.updated).toBe(1);
  const item = (await engine.sync.items(source.id))[0];
  status = 403;
  await startSync(engine, who, source.id);
  const failed = await finished(source.id);
  expect(failed.sync?.state).toBe("failed");
  expect(failed.sync?.note).toContain("HTTP 403");
  expect((await engine.sync.items(source.id))[0]?.source_version_id).toBe(item?.source_version_id);
  status = 200;
  await startSync(engine, who, source.id);
  expect((await finished(source.id)).sync?.state).toBe("succeeded");
});

test("connection management checks the tenant and maintainer, never accepts secrets or arbitrary endpoints", async () => {
  const body = { type: "confluence", name: "HR", targets: ["HR"], governance_level: "reference" };
  await expect(connectSource(engine, { ...who, tenant_id: "ten_00000000OTHER" }, space, body)).rejects.toThrow(
    "no space",
  );
  await expect(connectSource(engine, { ...who, id: "mem_00000000OTHER" }, space, body)).rejects.toThrow("no space");
  await expect(
    connectSource(engine, who, space, { ...body, token: "never-accepted", base_url: "https://other.test" }),
  ).rejects.toThrow();
  await expect(connectionSecret("INSPIRATION_SIGNING_KEY")).rejects.toThrow();
  expect((await connections(engine, who, space)).sources).toEqual([]);
});

test("interrupted sync is visible and recoverable after restart", async () => {
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "reference",
  });
  await engine.sync.addSource({ ...source, sync: { state: "running", started_at: new Date().toISOString() } });
  await engine.sync.recover();
  expect((await engine.sync.getSource(source.id))?.sync).toMatchObject({
    state: "failed",
    note: expect.stringContaining("restart"),
  });
  await startSync(engine, who, source.id);
  expect((await finished(source.id)).sync?.state).toBe("succeeded");
});

test("a conflict in a small source reaches the space owner before topics exist", async () => {
  small = true;
  const first = await connectSource(engine, who, space, {
    type: "confluence",
    name: "Policy",
    targets: ["HR"],
    governance_level: "governed",
  });
  await startSync(engine, who, first.id);
  await finished(first.id);
  amount = 25;
  const second = await connectSource(engine, who, space, {
    type: "confluence",
    name: "Notice",
    targets: ["NEWS"],
    governance_level: "governed",
  });
  await startSync(engine, who, second.id);
  await finished(second.id);
  expect(await engine.store.topics(TENANT)).toEqual([]);
  const conflicts = (await engine.inbox.items(TENANT, { open: true })).filter((i) => i.todo.kind === "conflict");
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.todo.assignee_id).toBe(MEMBER);
});

test("reading an unchanged passage uses the cited version and updates its standing", async () => {
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "reference",
  });
  await startSync(engine, who, source.id);
  await finished(source.id);
  const original = (await engine.sync.items(source.id))[0]?.source_version_id;
  amount = 25;
  await startSync(engine, who, source.id);
  await finished(source.id);
  const latest = (await engine.sync.items(source.id))[0]?.source_version_id;
  assert(original && latest);
  expect(latest).not.toBe(original);
  const query = { question: "What is the meal allowance?" };
  const hits = await engine.compact.sources(query, who);
  const citation = hits.flatMap((h) => h.citations).find((c) => c.quote.includes("Meal allowance"));
  assert(citation);
  const [span] = await engine.store.getSpans([citation.span_id]);
  expect(citation.source_version_id).toBe(latest);
  assert(span?.block_id);
  expect(span.source_version_id).toBe(original);
  const read = vi.spyOn(engine.extraction, "extractOnUse");
  await engine.compact.answer(query, who);
  expect(read.mock.calls.some(([id]) => id === original)).toBe(false);
  expect(read.mock.calls.some(([id]) => id === latest)).toBe(true);
  const correct = await engine.extraction.extractOnUse(latest, [span.block_id]);
  expect(correct.added).toEqual([]);
});

test("governed answers finish while another tenant has blocked background work", async () => {
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "governed",
  });
  await startSync(engine, who, source.id);
  await finished(source.id);
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let entered = false;
  engine.observe("claims.updated", "review-probe", async (event) => {
    if (event.tenant_id === "ten_00000000OTHER") {
      entered = true;
      await blocked;
    }
  });
  await engine.store.transaction((tx) =>
    tx.publish(
      newEvent(
        "claims.updated",
        {
          origin: "extracted",
          added: [],
          updated: [],
          superseded: [],
        },
        { tenantId: "ten_00000000OTHER", producer: "extraction" },
      ),
    ),
  );
  engine.settleLater();
  let answered = false;
  try {
    await expect.poll(() => entered).toBe(true);
    const answer = engine.compact.answer({ question: "What is the leave allowance?" }, who).then((value) => {
      answered = true;
      return value;
    });
    await expect.poll(() => answered, { timeout: 2000 }).toBe(true);
    expect((await answer).citations.length).toBeGreaterThan(0);
    release();
    await answer;
  } finally {
    release();
  }
});

test("an inaccessible Feishu link fails individually while readable documents update", async () => {
  vi.stubEnv("INSPIRATION_FEISHU_APP_ID", "review-app");
  vi.stubEnv("INSPIRATION_FEISHU_APP_SECRET", randomBytes(24).toString("hex"));
  let revision = 1;
  let denied = false;
  vi.stubGlobal("fetch", async (url: URL) => {
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.pathname.endsWith("/internal"))
      return reply({ code: 0, tenant_access_token: randomBytes(24).toString("hex"), expire: 7200 });
    const id = url.pathname.includes("docA") ? "docA" : "docB";
    if (id === "docB" && denied) return reply({ code: 999 }, 403);
    if (!url.pathname.endsWith("/blocks"))
      return reply({ code: 0, data: { document: { document_id: id, title: id, revision_id: revision } } });
    return reply({
      code: 0,
      data: {
        items: [
          { block_id: "root", block_type: 1, children: ["p"] },
          {
            block_id: "p",
            block_type: 2,
            text: { elements: [{ text_run: { content: `Leave allowance: ${revision * 20} days.` } }] },
          },
        ],
        has_more: false,
      },
    });
  });
  const source = await connectSource(engine, who, space, {
    type: "feishu.docx",
    name: "Policies",
    targets: ["https://example.feishu.cn/docx/docA", "https://example.feishu.cn/docx/docB"],
    governance_level: "reference",
  });
  await startSync(engine, who, source.id);
  await finished(source.id);
  const before = (await engine.sync.items(source.id)).find((i) => i.external_id === "docA");
  revision = 2;
  denied = true;
  await startSync(engine, who, source.id);
  const result = await finished(source.id);
  const after = (await engine.sync.items(source.id)).find((i) => i.external_id === "docA");
  expect(result.sync?.state).toBe("failed");
  expect(result.sync?.report?.outcomes).toMatchObject({ updated: 1, failed: 1, deleted: 0 });
  expect(result.sync?.report?.errors).toEqual([{ external_id: "docB", error: expect.stringContaining("403") }]);
  assert(before && after);
  expect(after.source_version_id).not.toBe(before.source_version_id);
});

test("the synchronous API updates the same persisted status after a failed background sync", async () => {
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "reference",
  });
  status = 403;
  await startSync(engine, who, source.id);
  expect((await finished(source.id)).sync?.state).toBe("failed");
  status = 200;
  const report = await syncNow(engine, who, source.id);
  expect(report?.outcomes.created).toBe(1);
  expect((await connections(engine, who, space)).sources[0]?.sync?.state).toBe("succeeded");
});

test("answer-time reading and owner routing work with catalogue discovery disabled", async () => {
  await engine.close();
  await openEngine(false);
  const source = await connectSource(engine, who, space, {
    type: "confluence",
    name: "HR",
    targets: ["HR"],
    governance_level: "reference",
  });
  await startSync(engine, who, source.id);
  await finished(source.id);
  const before = engine.extraction.totals.windows;
  const read = vi.spyOn(engine.extraction, "extractOnUse");
  await engine.compact.answer({ question: "What is the leave allowance?" }, who);
  expect(engine.extraction.totals.windows).toBeGreaterThan(before);
  const result = await read.mock.results[0]?.value;
  const claim = result?.added[0];
  assert(claim);
  await engine.store.transaction((tx) =>
    tx.publish(
      newEvent(
        "todo.requested",
        {
          kind: "note",
          space_id: space,
          title: "Check the policy",
          detail: "Review this statement.",
          priority: "normal",
          unit_ids: [claim],
          dedupe_key: "review-without-discovery",
        },
        { tenantId: TENANT, producer: "governance" },
      ),
    ),
  );
  await engine.settle();
  expect((await engine.inbox.items(TENANT, { open: true })).some((item) => item.todo.assignee_id === MEMBER)).toBe(
    true,
  );
});
