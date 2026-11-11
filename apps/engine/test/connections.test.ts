import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, Source } from "@inspiration/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectionSecret, connections, connectSource, recoverConnections, startSync } from "../src/connections.ts";
import { Engine } from "../src/engine.ts";
import { answerWithReading, organizeKnowledge } from "../src/reading-on-use.ts";

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
  engine = await Engine.open({ blobDir: dir, secret: connectionSecret, discoverFacts: true });
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
});
afterEach(async () => {
  await engine?.close();
  upstream?.close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

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
  const answer = await answerWithReading(engine, { question: "What is the leave allowance?" }, who);
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
  await recoverConnections(engine);
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
