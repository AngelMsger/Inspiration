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
  type Inbox,
  type InboxTodo,
  type TopicList,
  type TopicView,
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
  leave: { topic: string; fact: string; slot: string; question: string; values: string[]; titles: string[] };
}>(import.meta.url, "corpus.yaml");
const TRAVEL = DATA.travel.item;
const BUDGET = DATA.budget.item;
// In the finance group, which alone reads the internal budget note.
const LI_NA = "mem_01QINGHE00000000000000LINA";
// Wrote the attendance policy and the onboarding guide, so owns their topics.
const ZHANG_MIN = "mem_01QINGHE000000000ZHANGMIN";

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

  test("lists a space's topics, and shows one with every value of the facts it holds", async () => {
    const list = await call(`/v0/spaces/${POLICY}/topics`);
    expect(contractErrors("TopicList", list.body)).toEqual([]);
    const leave = (list.body as unknown as TopicList).topics.find((t) => t.title === DATA.leave.topic);
    expect(leave).toBeDefined();
    const { status, body } = await call(`/v0/topics/${leave?.key}`);
    expect(status).toBe(200);
    expect(contractErrors("TopicView", body)).toEqual([]);
    const view = body as unknown as TopicView;
    const fact = view.facts.find((f) => f.slot_key === DATA.leave.slot);
    expect(fact?.label).toBe(DATA.leave.fact);
    // The guide's 7 days live in another topic, and still show against the policy's 5.
    expect(
      view.statements
        .filter((h) => h.slot_key === fact?.slot_key)
        .map((h) => [h.title, h.standing])
        .sort(),
    ).toEqual(
      [
        [DATA.leave.titles[0], "holds"],
        [DATA.leave.titles[1], "disputed"],
      ].sort(),
    );
    expect((await call("/v0/topics/t-nothing")).status).toBe(404);
  });

  // Last: the choice changes what the tenant knows.
  test("a todo's owner sees what it asks them to choose, and the choice changes the answer", async () => {
    const reader = await call("/v0/inbox");
    expect(reader.body).toEqual({ cards: [] });
    const { status, body } = await call("/v0/inbox", { member: ZHANG_MIN });
    expect(status).toBe(200);
    expect(contractErrors("Inbox", body)).toEqual([]);
    const leave = (body as unknown as Inbox).cards
      .flatMap((c) => c.todos)
      .find((t) => t.todo.slot_key === DATA.leave.slot) as InboxTodo;
    const titleOf = new Map(leave.statements.map((h) => [h.unit_id, h.title]));
    expect(leave.choices.map((c) => [c.value, titleOf.get(c.unit_id ?? "")])).toEqual(
      DATA.leave.values.map((v, i) => [v, DATA.leave.titles[i]]),
    );
    const notes = async () =>
      (
        (await call("/v0/answers", { body: { question: DATA.leave.question } })).body as unknown as GroundedAnswer
      ).notes?.map((n) => n.kind) ?? [];
    expect(await notes()).toContain("conflict");

    const resolve = (body: unknown, member = ZHANG_MIN) => call(`/v0/todos/${leave.todo.id}/resolve`, { member, body });
    // The owner confirms the value governance proposed.
    const proposed = leave.choices[0]?.key;
    expect((await resolve({ with: proposed }, corpus.reader.id)).status).toBe(404);
    expect((await resolve({ with: "choose:9 day" })).status).toBe(400);
    expect((await resolve({})).status).toBe(400);
    const done = await resolve({ with: proposed });
    expect(done.status).toBe(200);
    expect(contractErrors("Todo", done.body)).toEqual([]);
    expect(done.body).toMatchObject({ status: "done", resolved_by: ZHANG_MIN, resolved_with: proposed });

    // The guide's 7 days no longer stand against the policy: they are out of date.
    expect(await notes()).toEqual(["outdated"]);
    const after = (await call("/v0/inbox", { member: ZHANG_MIN })).body as unknown as Inbox;
    expect(after.cards.flatMap((c) => c.todos).map((t) => t.todo.id)).not.toContain(leave.todo.id);
    const topic = (await call(`/v0/topics/${leave.todo.taxonomy_key}`)).body as unknown as TopicView;
    expect(topic.statements.filter((h) => h.slot_key === leave.todo.slot_key).map((h) => h.standing)).toEqual(
      expect.arrayContaining(["holds", "outdated"]),
    );
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
