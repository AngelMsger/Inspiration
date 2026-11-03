// The HTTP API over the demo corpus, in memory: every route, its contract, and that a member
// sees only what they may read.

import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Citation,
  contractErrors,
  type DocumentTree,
  type DocumentTreeNode,
  type DocumentView,
  type GroundedAnswer,
} from "@inspiration/contracts";
import { testData } from "@inspiration/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Corpus, Engine, seed, serveApi } from "../src/index.ts";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus/", import.meta.url));
const POLICY = "spc_01QINGHE000000000000POLICY";
const POLICIES = "src_01QINGHE00000000000POLICIES";
const DATA = testData<{
  spaces: string[];
  travel: { item: string; title: string; folder: string; outdated: string; held: string; held_by: string };
  budget: { item: string; title: string; folder: string };
  question: string;
  search: string;
}>(import.meta.url, "corpus.yaml");
const TRAVEL = DATA.travel.item;
const BUDGET = DATA.budget.item;
// In the finance group, which alone reads the internal budget note.
const LI_NA = "mem_01QINGHE00000000000000LINA";

let engine: Engine;
let server: Server;
let corpus: Corpus;
let blobs: string;

beforeAll(async () => {
  corpus = await Corpus.load(CORPUS);
  blobs = await mkdtemp(join(tmpdir(), "inspiration-http-"));
  engine = await Engine.open({
    blobDir: blobs,
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    clock: () => new Date("2026-10-27T09:00:00Z"),
  });
  await seed(engine, corpus);
  server = await serveApi(
    engine,
    { tenant: (id) => (id === corpus.tenantId ? corpus.tenant : undefined), spaces: () => corpus.spaces },
    0,
  );
}, 120_000);

afterAll(async () => {
  server?.close();
  await engine?.close();
  await rm(blobs, { recursive: true, force: true });
});

async function call(path: string, options: { member?: string; body?: unknown; anonymous?: boolean } = {}) {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = options.anonymous
    ? {}
    : { "x-inspiration-tenant": corpus.tenantId, "x-inspiration-member": options.member ?? corpus.reader.id };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const titles = (n: DocumentTreeNode): string[] =>
  n.kind === "document" ? [n.name] : (n.children ?? []).flatMap(titles);

describe("engine HTTP API", () => {
  test("lists the spaces the member may read", async () => {
    const { status, body } = await call("/v0/spaces");
    expect(status).toBe(200);
    expect(contractErrors("SpaceList", body)).toEqual([]);
    expect((body.spaces as { name: string }[]).map((s) => s.name)).toEqual(DATA.spaces);
  });

  test("builds the Documents tree without the folders a member cannot open", async () => {
    const reader = await call(`/v0/spaces/${POLICY}/documents`);
    expect(contractErrors("DocumentTree", reader.body)).toEqual([]);
    const tree = reader.body as unknown as DocumentTree;
    const policies = tree.sources.find((s) => s.source_id === POLICIES) as DocumentTreeNode;
    expect(titles(policies)).toContain(DATA.travel.title);
    expect(titles(policies)).not.toContain(DATA.budget.title);
    const finance = policies.children?.find((c) => c.name === DATA.travel.folder);
    expect(finance?.children?.map((c) => c.name)).not.toContain(DATA.budget.folder);

    const member = (await call(`/v0/spaces/${POLICY}/documents`, { member: LI_NA })).body as unknown as DocumentTree;
    const theirs = member.sources.find((s) => s.source_id === POLICIES) as DocumentTreeNode;
    expect(titles(theirs)).toContain(DATA.budget.title);
    expect(theirs.document_count).toBe((policies.document_count ?? 0) + 1);
  });

  test("shows a document with its blocks and the marks on them", async () => {
    const { status, body } = await call(`/v0/documents?source=${POLICIES}&item=${encodeURIComponent(TRAVEL)}`);
    expect(status).toBe(200);
    expect(contractErrors("DocumentView", body)).toEqual([]);
    const view = body as unknown as DocumentView;
    expect(view.path).toEqual([DATA.travel.folder]);
    expect(view.blocks.length).toBeGreaterThan(10);
    const outdated = view.annotations.statements.find((s) => s.standing === "outdated");
    expect(outdated?.snippet).toContain(DATA.travel.outdated);
    const held = view.annotations.held.find((h) => h.unit_id === outdated?.held_unit_id);
    expect(held?.snippet).toContain(DATA.travel.held);
    expect(held?.citations[0]?.source_title).toBe(DATA.travel.held_by);
  });

  test("opens the version a citation names, as the reader may", async () => {
    const answer = (await call("/v0/answers", { body: { question: DATA.question } })).body as unknown as GroundedAnswer;
    const cited = answer.citations.find((c) => c.source_title === DATA.travel.held_by) as Citation;
    const { status, body } = await call(`/v0/documents?version=${cited.source_version_id}`);
    expect(status).toBe(200);
    const view = body as unknown as DocumentView;
    expect(view.document.title).toBe(DATA.travel.held_by);
    expect(view.blocks.some((b) => b.span_ids.includes(cited.span_id))).toBe(true);
    expect((await call("/v0/documents?version=sv_01NOTHING00000000000000000")).status).toBe(404);
    expect((await call("/v0/documents")).status).toBe(400);
  });

  test("answers a question with citations and a note on the replaced value", async () => {
    const { status, body } = await call("/v0/answers", { body: { question: DATA.question } });
    expect(status).toBe(200);
    expect(contractErrors("GroundedAnswer", body)).toEqual([]);
    expect(body.answer).toContain(DATA.travel.held);
    expect((body.notes as { kind: string }[]).map((n) => n.kind)).toContain("outdated");
  });

  test("searches", async () => {
    const { status, body } = await call("/v0/search", { body: { text: DATA.search } });
    expect(status).toBe(200);
    expect(contractErrors("SearchResult", body)).toEqual([]);
    expect((body.hits as unknown[]).length).toBeGreaterThan(0);
  });

  test("a document the member may not read is not found, as an unknown one is", async () => {
    const hidden = await call(`/v0/documents?source=${POLICIES}&item=${encodeURIComponent(BUDGET)}`);
    const unknown = await call(`/v0/documents?source=${POLICIES}&item=nothing.md`);
    expect([hidden.status, unknown.status]).toEqual([404, 404]);
    expect(hidden.body).toEqual({ error: { code: "not_found", message: "no document" } });
    expect(unknown.body).toEqual(hidden.body);
    expect(
      (await call(`/v0/documents?source=${POLICIES}&item=${encodeURIComponent(BUDGET)}`, { member: LI_NA })).status,
    ).toBe(200);
  });

  test("refuses a request without a member, and a body that is not valid", async () => {
    const anonymous = await call("/v0/spaces", { anonymous: true });
    expect(anonymous.status).toBe(401);
    expect(contractErrors("ApiError", anonymous.body)).toEqual([]);
    expect((await call("/v0/answers", { body: { question: "" } })).status).toBe(400);
    expect((await call("/v0/nothing")).status).toBe(404);
  });

  test("answers a request target that is not a URL with 400, and keeps serving", async () => {
    // fetch would normalize the target; a raw request sends it as it is.
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "//[" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(await call("/v0/health", { anonymous: true })).toEqual({ status: 200, body: { ok: true } });
  });
});
