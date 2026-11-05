// Uploading files into a space over HTTP, on an engine the tenancy service provisions: an
// editor puts a file, it is in the Documents tree at once and read in the background, with
// how far reading has come, and the route refuses who may not upload and what the engine
// does not take.

import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenVerifier } from "@inspiration/access-control";
import { devIssuer } from "@inspiration/access-control/testing";
import {
  contractErrors,
  type DocumentEntry,
  type DocumentTree,
  type DocumentTreeNode,
  type DocumentView,
  type FileWritten,
} from "@inspiration/contracts";
import type { BudgetConfig, Gateway } from "@inspiration/model-gateway";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Engine, serveApi } from "../src/index.ts";
import { MAX_FILE_BYTES } from "../src/uploads.ts";

const TENANT = "ten_01QINGHE000000000000000001";
const SERVICE = "svc_01TENANCY0000000000000000";
const ADMIN = "mem_01QINGHE00000000000000ADMIN"; // the super admin, in no audience
const ZHOU = "mem_01QINGHE0000000000ZHOUMIN"; // owns the space
const LINA = "mem_01QINGHE00000000000000LINA"; // edits it
const CHEN = "mem_01QINGHE00000000000000CHEN"; // reads it

const issuer = devIssuer();
let engine: Engine;
let server: Server;
let blobs: string;
let space: string;

interface Call {
  method?: string;
  as?: string;
  body?: unknown;
  /** Bytes to send as they are, for an upload. */
  bytes?: Uint8Array | string;
  headers?: Record<string, string>;
  scope?: string;
}

async function call(path: string, options: Call = {}) {
  const { port } = server.address() as AddressInfo;
  const sub = options.as ?? LINA;
  const kind = sub.startsWith("svc_") ? "service" : "member";
  const token = issuer.mint({ sub, tid: TENANT, kind, ...(options.scope && { scope: options.scope }) });
  const body = options.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? (options.bytes !== undefined ? "PUT" : body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, ...options.headers },
    ...(body !== undefined && { body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const filePath = (path: string) => `/v0/spaces/${space}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
const treeOf = async () => (await call(`/v0/spaces/${space}/documents`, { as: CHEN })).body as unknown as DocumentTree;
/** The tree's entry for the document of that title. */
function entryIn(tree: DocumentTree, title: string): DocumentEntry | undefined {
  const walk = (n: DocumentTreeNode): DocumentEntry[] => [
    ...(n.document?.title === title ? [n.document] : []),
    ...(n.children ?? []).flatMap(walk),
  ];
  return tree.sources.flatMap(walk)[0];
}
const errorOf = (r: { status: number; body: Record<string, unknown> }) => [
  r.status,
  (r.body.error as { code: string } | undefined)?.code,
];

beforeAll(async () => {
  blobs = await mkdtemp(join(tmpdir(), "inspiration-uploads-"));
  engine = await Engine.open({ blobDir: blobs });
  server = await serveApi(engine, 0, {
    tokens: new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys: issuer.keys }),
  });
  const tenant = { name: "Qinghe Tech", kind: "team", default_locale: "en", version: 1 };
  expect((await call(`/v0/tenants/${TENANT}`, { method: "PUT", as: SERVICE, body: tenant })).status).toBe(200);
  for (const [id, roles] of [
    [ADMIN, ["owner", "admin", "security_admin", "auditor"]],
    [ZHOU, ["member"]],
    [LINA, ["member"]],
    [CHEN, ["member"]],
  ] as const) {
    const member = { status: "active", display_name: id, roles, version: 1 };
    expect(
      (await call(`/v0/tenants/${TENANT}/members/${id}`, { method: "PUT", as: SERVICE, body: member })).status,
    ).toBe(200);
  }
  const created = await call("/v0/spaces", { as: ADMIN, body: { name: "Policies", owner_ids: [ZHOU] } });
  space = (created.body.space as { id: string }).id;
  const grants = [
    { principal_id: LINA, role: "editor" },
    { principal_id: CHEN, role: "viewer" },
  ];
  expect((await call(`/v0/spaces/${space}/audience`, { method: "PUT", as: ZHOU, body: { grants } })).status).toBe(200);
});

afterAll(async () => {
  server?.close();
  await engine?.close();
  await rm(blobs, { recursive: true, force: true });
});

const TRAVEL = "policies/travel/Travel policy.md";

describe("uploads", () => {
  test("an editor's file is in the Documents tree at once, and read in the background", async () => {
    const put = await call(filePath(TRAVEL), {
      bytes: "# Travel policy\n\nHotels cost at most 600 a night.",
      headers: { "content-type": "application/octet-stream", "x-inspiration-modified": "2026-11-04T09:12:00Z" },
    });
    expect(put.status).toBe(200);
    expect(contractErrors("FileWritten", put.body)).toEqual([]);
    const written = put.body as unknown as FileWritten;
    expect(written).toMatchObject({
      changed: true,
      document: {
        external_id: TRAVEL,
        title: "Travel policy",
        mime_type: "text/markdown",
        governance_level: "reference",
        modified_at: "2026-11-04T09:12:00.000Z",
        reading: { state: "waiting" },
      },
    });

    const tree = await treeOf();
    expect(contractErrors("DocumentTree", tree)).toEqual([]);
    expect(tree.reading).toEqual({ waiting: 1, reading: 0, read: 0, paused: 0, failed: 0 });
    expect(tree.sources).toMatchObject([
      { kind: "source", name: "Uploads", source_type: "upload", source_id: written.document.source_id },
    ]);
    expect(tree.sources[0]?.children?.[0]).toMatchObject({ kind: "folder", name: "policies", document_count: 1 });

    await engine.settle();
    const item = `source=${written.document.source_id}&item=${encodeURIComponent(TRAVEL)}`;
    const view = (await call(`/v0/documents?${item}`, { as: CHEN })).body as unknown as DocumentView;
    expect(view.path).toEqual(["policies", "travel"]);
    expect(view.blocks.map((b) => b.text).join(" ")).toContain("600 a night");
    // Read: the entry says nothing more.
    expect(view.document.reading).toBeUndefined();
    expect((await treeOf()).reading).toEqual({ waiting: 0, reading: 0, read: 1, paused: 0, failed: 0 });
  });

  test("a file that cannot be read says why", async () => {
    // Unreadable whether or not a parsing worker runs: without one, it is out of reach.
    await call(filePath("scans/Scan.pdf"), { bytes: "%PDF-1.4 not a PDF after all" });
    await engine.settle();
    const tree = await treeOf();
    expect(entryIn(tree, "Scan")?.reading).toMatchObject({ state: "failed", note: expect.any(String) });
    expect(tree.reading?.failed).toBe(1);
  });

  test("reading a governed file pauses at a spent budget, and reads on once the budget renews", async () => {
    const area = await engine.sync.uploadArea(TENANT, space);
    await engine.sync.addSource({ ...area, governance_level: "governed" });
    const budgets = (engine.models as Gateway).config.budgets;
    const spent: BudgetConfig = { match: "tenant:*/extraction", period: "day", limit: 0 };
    budgets.unshift(spent);
    try {
      await call(filePath("policies/Meals.md"), { bytes: "# Meals\n\nMeals cost at most 100 a day." });
      await engine.settle();
      const paused = await treeOf();
      expect(entryIn(paused, "Meals")?.reading).toMatchObject({
        state: "paused",
        note: expect.stringContaining("budget"),
      });
      expect(paused.reading?.paused).toBe(1);
      expect(await engine.resumeReading()).toBe(0);
    } finally {
      budgets.splice(budgets.indexOf(spent), 1);
      await engine.sync.addSource(area);
    }
    expect(await engine.resumeReading()).toBe(1);
    await engine.settle();
    const read = await treeOf();
    expect(entryIn(read, "Meals")?.reading).toBeUndefined();
    expect(read.reading?.paused).toBe(0);
  });

  test("the same bytes change nothing; other bytes make a new version", async () => {
    const again = await call(filePath(TRAVEL), { bytes: "# Travel policy\n\nHotels cost at most 600 a night." });
    expect(again.body).toMatchObject({ changed: false });
    expect((again.body as unknown as FileWritten).document.reading).toBeUndefined();
    const next = await call(filePath(TRAVEL), { bytes: "# Travel policy\n\nHotels cost at most 650 a night." });
    expect(next.body).toMatchObject({ changed: true });
    const version = (next.body as unknown as FileWritten).document.source_version_id;
    expect(version).not.toBe((again.body as unknown as FileWritten).document.source_version_id);
    await engine.settle();
    const view = (await call(`/v0/documents?version=${version}`, { as: CHEN })).body as unknown as DocumentView;
    expect(view.blocks.map((b) => b.text).join(" ")).toContain("650 a night");
  });

  test("only editors and above upload; a space the member cannot read is not found", async () => {
    expect(errorOf(await call(filePath("notes.md"), { as: CHEN, bytes: "# Notes" }))).toEqual([403, "forbidden"]);
    expect(errorOf(await call(filePath("notes.md"), { as: ADMIN, bytes: "# Notes" }))).toEqual([404, "not_found"]);
    const readOnly = await call(filePath("notes.md"), { as: ZHOU, bytes: "# Notes", scope: "knowledge.read" });
    expect(errorOf(readOnly)).toEqual([403, "forbidden"]);
    expect((await call(filePath("notes.md"), { as: ZHOU, bytes: "# Notes" })).status).toBe(200);
  });

  test("refuses a type the engine does not read, and a path a file may not have", async () => {
    const exe = await call(filePath("tools/setup.exe"), { bytes: "MZ" });
    expect(errorOf(exe)).toEqual([415, "unsupported_type"]);
    expect((exe.body.error as { message: string }).message).toContain(".docx");
    expect(errorOf(await call(filePath("photo.png"), { bytes: "png" }))).toEqual([415, "unsupported_type"]);
    expect(errorOf(await call(filePath("README"), { bytes: "text" }))).toEqual([415, "unsupported_type"]);
    expect(errorOf(await call(`/v0/spaces/${space}/files/a%07.md`, { bytes: "x" }))).toEqual([400, "bad_request"]);
    expect(errorOf(await call(`/v0/spaces/${space}/files/a%E0.md`, { bytes: "x" }))).toEqual([400, "bad_request"]);
    expect(errorOf(await call(`/v0/spaces/${space}/files/a//b.md`, { bytes: "x" }))).toEqual([400, "bad_request"]);
    const modified = await call(filePath("a.md"), { bytes: "x", headers: { "x-inspiration-modified": "yesterday" } });
    expect(errorOf(modified)).toEqual([400, "bad_request"]);
  });

  test("refuses a file over 50 MiB, by its declared length or as it streams, and keeps serving", async () => {
    const { port } = server.address() as AddressInfo;
    const token = issuer.mint({ sub: LINA, tid: TENANT, kind: "member" });
    const send = (headers: Record<string, string | number>, chunks: number) =>
      new Promise<number | string>((resolve) => {
        const req = request(
          { port, method: "PUT", path: filePath("big.md"), headers: { authorization: `Bearer ${token}`, ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
            req.destroy();
          },
        );
        // The engine may close the connection before it answers; the file is refused all the same.
        req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
        const mib = Buffer.alloc(1024 * 1024, 97);
        const write = (left: number): void => {
          if (left === 0 || req.destroyed) return void req.end();
          req.write(mib, () => write(left - 1));
        };
        write(chunks);
      });
    expect(await send({ "content-length": MAX_FILE_BYTES + 1 }, 1)).toBe(413);
    expect([413, "ECONNRESET", "EPIPE"]).toContain(await send({ "transfer-encoding": "chunked" }, 51));
    const tree = (await call(`/v0/spaces/${space}/documents`)).body as unknown as DocumentTree;
    const names = JSON.stringify(tree);
    expect(names).not.toContain("big.md");
    expect((await call("/v0/health")).status).toBe(200);
  });
});
