// The usage page's numbers over the demo company: what its super admin reads in GET /v0/usage
// after members ask, an agent asks and the assistant decides, and that it is counts, times and
// cost, never content.

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokenVerifier } from "@inspiration/access-control";
import { devIssuer } from "@inspiration/access-control/testing";
import { contractErrors, type Inbox, type Usage } from "@inspiration/contracts";
import { testData } from "@inspiration/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Corpus, Engine, seed, serveApi } from "../src/index.ts";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus/", import.meta.url));
const DATA = testData<{ question: string; travel: { title: string }; budget: { title: string } }>(
  import.meta.url,
  "corpus.yaml",
);
const FINANCE = "spc_01HENGYUAN000000000FINANCE";
const ZHOU_MIN = "mem_01HENGYUAN000000000ZHOUMIN"; // maintains the finance space
const ZHAO_LIN = "mem_01HENGYUAN000000000ZHAOLIN"; // the super admin
const AGENT = "agt_01HENGYUAN0000000000HELPER";

const issuer = devIssuer();
let engine: Engine;
let server: Server;
let corpus: Corpus;
let blobs: string;

beforeAll(async () => {
  corpus = await Corpus.load(CORPUS);
  blobs = await mkdtemp(join(tmpdir(), "inspiration-usage-"));
  engine = await Engine.open({
    blobDir: blobs,
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: corpus.vocabularyOf,
    clock: () => new Date("2026-11-04T09:00:00Z"),
  });
  await seed(engine, corpus);
  server = await serveApi(engine, 0, {
    tokens: new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys: issuer.keys }),
  });
}, 120_000);

afterAll(async () => {
  server?.close();
  await engine?.close();
  await rm(blobs, { recursive: true, force: true });
});

async function call(path: string, options: { member?: string; body?: unknown; claims?: object } = {}) {
  const { port } = server.address() as AddressInfo;
  const token = issuer.mint({
    sub: options.member ?? corpus.reader.id,
    tid: corpus.tenantId,
    kind: "member",
    ...options.claims,
  });
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("usage", () => {
  test("shows the super admin the month's cost, answers, times and decisions, by member, space and day", async () => {
    const before = (await call("/v0/usage", { member: ZHAO_LIN })).body as unknown as Usage;
    // The reader asks twice, once through an agent; the finance maintainer lets the assistant decide a card.
    expect((await call("/v0/answers", { body: { question: DATA.question } })).status).toBe(200);
    const ask = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask", arguments: { question: DATA.question } },
    };
    const agent = {
      sub: AGENT,
      kind: "agent",
      scope: "knowledge.read",
      obo: corpus.reader.id,
      grant: "tok_01HENGYUAN0000000000HELPER",
    };
    const asked = (await call("/v0/mcp", { body: ask, claims: agent })).body as { result: { isError?: boolean } };
    expect(asked.result.isError).toBeUndefined();
    const inbox = (await call("/v0/inbox", { member: ZHOU_MIN })).body as unknown as Inbox;
    const decided = await call("/v0/inbox/decide", {
      member: ZHOU_MIN,
      body: { batch_key: inbox.cards[0]?.batch_key },
    });
    expect(decided.status).toBe(200);

    const { status, body } = await call("/v0/usage", { member: ZHAO_LIN });
    expect(status).toBe(200);
    expect(contractErrors("Usage", body)).toEqual([]);
    const usage = body as unknown as Usage;
    expect(usage).toMatchObject({ tenant_id: corpus.tenantId, month: "2026-11", time_zone: "Asia/Shanghai" });
    // Up to today, 4 November in Shanghai.
    expect(usage.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);

    const { totals } = usage;
    expect(totals.answers - before.totals.answers).toBe(2);
    expect(totals.agent_answers - before.totals.agent_answers).toBe(1);
    expect(totals.answer_ms_p90).toBeGreaterThanOrEqual(totals.answer_ms_p50 as number);
    expect(totals.decided - before.totals.decided).toBeGreaterThan(0);
    expect(totals.cost.amount).toBeGreaterThan(before.totals.cost.amount);
    // The days add up to the month; the totals count upkeep no member or space is charged for too.
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    expect(sum(usage.days.map((d) => d.cost.amount))).toBeCloseTo(totals.cost.amount, 6);
    expect(sum(usage.days.map((d) => d.answers))).toBe(totals.answers);
    const charged = sum([...usage.by_member, ...usage.by_space].map((r) => r.cost.amount));
    expect(charged).toBeLessThanOrEqual(totals.cost.amount + 1e-6);

    // The reader's row: both answers, the agent's among them, and what they cost.
    const reader = usage.by_member.find((m) => m.member_id === corpus.reader.id);
    expect(reader).toMatchObject({ answers: 2, agent_answers: 1 });
    expect(reader?.cost.amount).toBeGreaterThan(0);
    expect(usage.by_member.find((m) => m.member_id === ZHOU_MIN)?.decided).toBeGreaterThan(0);

    // Every space has a row; reading the finance space's documents is charged to it.
    expect(usage.by_space.map((s) => s.space_id)).toEqual(
      (await engine.directory.spaces(corpus.tenantId)).map((s) => s.id).sort(),
    );
    const finance = usage.by_space.find((s) => s.space_id === FINANCE);
    expect(finance?.cost.amount).toBeGreaterThan(0);
    expect(finance?.answers).toBeGreaterThan(0);
    expect(totals.documents).toBe(sum(usage.by_space.map((s) => s.documents as number)));
    expect(totals.documents_read).toBeLessThanOrEqual(totals.documents as number);
    expect(totals.todos).toBeGreaterThan(0);

    // The month's budgets as they stand: the development gateway caps each component's month.
    expect(usage.budgets.map((b) => [b.budget_key, b.period])).toEqual([
      [`tenant:${corpus.tenantId}/extraction`, "month"],
      [`tenant:${corpus.tenantId}/retrieval`, "month"],
      [`tenant:${corpus.tenantId}/page-compiler`, "month"],
    ]);

    // Counts, times and cost: never a question or a document.
    const text = JSON.stringify(usage);
    for (const words of [DATA.question, DATA.travel.title, DATA.budget.title]) expect(text).not.toContain(words);
  });

  test("is the super admin's alone, and reads any month asked for", async () => {
    expect((await call("/v0/usage")).status).toBe(403);
    expect((await call("/v0/usage", { member: ZHOU_MIN })).status).toBe(403);
    expect((await call("/v0/usage?month=2026-13", { member: ZHAO_LIN })).status).toBe(400);
    const october = (await call("/v0/usage?month=2026-10", { member: ZHAO_LIN })).body as unknown as Usage;
    expect(october.days).toHaveLength(31);
    expect(october.totals).toMatchObject({ answers: 0, decided: 0, cost: { amount: 0 } });
    expect((await call("/v0/usage?month=2026-12", { member: ZHAO_LIN })).body).toMatchObject({ days: [] });
  });
});
