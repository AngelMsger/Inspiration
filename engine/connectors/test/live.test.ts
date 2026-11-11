import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractErrors, type NormalizedDocument, type Source } from "@inspiration/contracts";
import { LocalBlobStore, registry } from "@inspiration/kernel";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConfluenceConnector, feishuDocxConnector } from "../src/index.ts";

let dir: string;
const credential = randomBytes(24).toString("hex");
const source = (type: string): Source => ({
  id: "src_00000000LIVE",
  tenant_id: "ten_00000000LIVE",
  space_id: "spc_00000000LIVE",
  type,
  name: "Policies",
  status: "active",
  created_at: "2026-11-01T00:00:00Z",
  credentials_ref: "test",
  scope: { kind: type, ids: ["HR"], options: { base_url: "https://wiki.example.test/confluence" } },
});
const page = (id = "12", text = "<p>Leave allowance: 20 days.</p>", revision = 1) => ({
  id,
  title: "Leave",
  version: { number: revision, when: "2026-11-01T00:00:00Z" },
  body: { view: { value: text } },
  ancestors: [{ title: "HR" }],
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-live-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
const context = () => ({ blobs: new LocalBlobStore(dir), secret: async () => credential });

test("Confluence follows pages within the configured context, cites originals and detects revisions", async () => {
  let current = page();
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      requests.push(url);
      expect(url.origin).toBe("https://wiki.example.test");
      expect(url.pathname).toBe("/confluence/rest/api/content");
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${credential}`);
      const start = Number(url.searchParams.get("start"));
      return response({
        results: [start ? page("13") : current],
        start,
        size: 1,
        limit: 1,
        _links: start ? {} : { next: "https://untrusted.test/steal" },
      });
    }),
  );
  const ctx = context();
  const connector = new ConfluenceConnector(source("confluence"), ctx);
  const first = await connector.list(connector.source.scope);
  expect(first.next_cursor).toBe("1");
  expect((await connector.list(connector.source.scope, first.next_cursor)).next_cursor).toBeUndefined();
  const doc = (await connector.fetch(first.items[0]?.ref ?? { source_id: "", external_id: "" })) as NormalizedDocument;
  expect(contractErrors("NormalizedDocument", doc)).toEqual([]);
  expect(doc.metadata?.url).toBe("https://wiki.example.test/confluence/pages/viewpage.action?pageId=12");
  expect(doc.acl?.fidelity).toBe("connection_scoped");
  expect(
    new TextDecoder().decode(await ctx.blobs.get(doc.file ?? { uri: "", sha256: "", size_bytes: 0, mime_type: "" })),
  ).toContain("20 days");
  expect(await connector.fetch(doc.ref, doc.version)).toEqual({ unchanged: true });
  current = page("12", "<p>Leave allowance: 25 days.</p>", 2);
  await connector.list(connector.source.scope);
  const changed = (await connector.fetch(doc.ref, doc.version)) as NormalizedDocument;
  expect(changed.version.content_hash).not.toBe(doc.version.content_hash);
  expect(changed.version.external_version).toBe("2");
  expect(requests).toHaveLength(3);
  expect(await registry("connectors").get("confluence")).toBeTypeOf("function");
});

test.each([401, 403, 429, 500])(
  "Confluence reports HTTP %s without returning a server body or credential",
  async (status) => {
    vi.stubGlobal("fetch", async () => response({ error: credential }, status));
    const connector = new ConfluenceConnector(source("confluence"), context());
    const error = await connector.list(connector.source.scope).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toContain(credential);
  },
);

test("an incomplete Confluence listing fails instead of presenting an empty source", async () => {
  vi.stubGlobal("fetch", async () =>
    response({ results: [], start: 0, limit: 25, size: 0, _links: { next: "/rest/api/content?start=25" } }),
  );
  const connector = new ConfluenceConnector(source("confluence"), context());
  await expect(connector.list(connector.source.scope)).rejects.toThrow("incomplete");
});

test("Feishu resolves wiki links, pins all block pages to a revision and refreshes on re-sync", async () => {
  let revision = 7;
  let auth = 0;
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    requests.push(url);
    expect(url.origin).toBe("https://open.feishu.cn");
    expect(init.redirect).toBe("error");
    if (url.pathname.endsWith("/internal")) {
      auth++;
      return response({ code: 0, tenant_access_token: credential, expire: 7200 });
    }
    if (url.pathname.endsWith("/get_node"))
      return response({ code: 0, data: { node: { obj_type: "docx", obj_token: "doc123" } } });
    if (url.pathname.endsWith("/doc123"))
      return response({
        code: 0,
        data: { document: { document_id: "doc123", title: "Leave", revision_id: revision } },
      });
    expect(url.searchParams.get("document_revision_id")).toBe(String(revision));
    const second = url.searchParams.has("page_token");
    return response({
      code: 0,
      data: {
        items: second
          ? [
              {
                block_id: "paragraph",
                block_type: 2,
                text: { elements: [{ text_run: { content: `Leave allowance: ${revision} days.` } }] },
              },
            ]
          : [{ block_id: "root", block_type: 1, children: ["paragraph"] }],
        has_more: !second,
        ...(!second && { page_token: "next" }),
      },
    });
  });
  const src = source("feishu.docx");
  src.scope = { kind: "feishu.documents", ids: ["https://example.feishu.cn/wiki/wiki123"] };
  const connector = feishuDocxConnector(src, {
    ...context(),
    secret: async () => JSON.stringify({ app_id: "test-app", app_secret: credential }),
  });
  const list = await connector.list(src.scope);
  expect(list.items).toHaveLength(1);
  expect(requests).toHaveLength(0);
  expect(list.items[0]?.ref.external_id).toBe("wiki:wiki123");
  const doc = (await connector.fetch(list.items[0]?.ref ?? { source_id: "", external_id: "" })) as NormalizedDocument;
  expect(contractErrors("NormalizedDocument", doc)).toEqual([]);
  expect(doc.metadata?.url).toBe(src.scope.ids?.[0]);
  expect(doc.blocks?.[0]?.anchor).toBe("paragraph");
  expect(doc.acl?.fidelity).toBe("connection_scoped");
  expect(requests).toHaveLength(5);
  revision = 8;
  await connector.list(src.scope);
  const next = (await connector.fetch(doc.ref, doc.version)) as NormalizedDocument;
  expect(next.blocks?.[0]?.text).toContain("8 days");
  expect(auth).toBe(1);
});

test("a missing Feishu page token aborts the import", async () => {
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.pathname.endsWith("/internal")) return response({ code: 0, tenant_access_token: credential, expire: 7200 });
    if (url.pathname.endsWith("/doc123"))
      return response({ code: 0, data: { document: { document_id: "doc123", title: "Leave", revision_id: 1 } } });
    return response({ code: 0, data: { items: [], has_more: true } });
  });
  const src = source("feishu.docx");
  src.scope.ids = ["https://example.feishu.cn/docx/doc123"];
  const connector = feishuDocxConnector(src, {
    ...context(),
    secret: async () => JSON.stringify({ app_id: "test-app", app_secret: credential }),
  });
  const [item] = (await connector.list(src.scope)).items;
  await expect(connector.fetch(item?.ref ?? { source_id: "", external_id: "" })).rejects.toThrow(
    "incomplete block listing",
  );
});
