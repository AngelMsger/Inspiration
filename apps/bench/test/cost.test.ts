import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageRecord } from "@inspiration/contracts";
import { Corpus, Engine } from "@inspiration/engine";
import { Gateway, loadGatewayConfig, MemoryUsage, standIn } from "@inspiration/model-gateway";
import { expect, test } from "vitest";
import {
  costReport,
  ingest,
  loadQuestions,
  type Question,
  questionsReport,
  RunUsage,
  sampleQuestions,
} from "../src/index.ts";

const KUBERNETES = fileURLToPath(new URL("../../../examples/kubernetes-docs/", import.meta.url));
const DEEPSEEK = fileURLToPath(new URL("../../../config/gateway.deepseek.yaml", import.meta.url));

test("a dry run on the DeepSeek config prices each task and answering path, long context mostly from cache", async () => {
  const corpus = await Corpus.load(KUBERNETES);
  const blobDir = await mkdtemp(join(tmpdir(), "inspiration-cost-"));
  const gateway = await Gateway.create(standIn(loadGatewayConfig(DEEPSEEK)));
  const engine = await Engine.open({
    blobDir,
    models: gateway,
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
  });
  try {
    await ingest(engine, corpus);
    const all = (await loadQuestions(KUBERNETES)) as Question[];
    const sample = sampleQuestions(all, 4);
    expect(sample.map((q) => all.indexOf(q))).toEqual([0, 3, 6, 9]);
    const asked = await questionsReport(engine, corpus, sample);
    const cost = asked.cost;
    expect(cost?.currency).toBe("USD");
    for (const path of ["engine", "mature", "long_context", "governed_long_context"] as const) {
      expect(cost?.[path].calls, path).toBeGreaterThan(0);
      expect(cost?.[path].cost, path).toBeGreaterThan(0);
    }
    // Every question gives long context the same sources first: after the first, a prefix cache serves them.
    const long = cost?.long_context;
    expect(long?.cached_input_tokens).toBeGreaterThan(0.7 * (long?.input_tokens ?? 0));

    const run = costReport(engine);
    expect(run?.by_task["extraction.extract_claims"]?.cost).toBeGreaterThan(0);
    // The stand-in embeddings and reranker are free.
    expect([run?.by_task.embed?.cost, run?.by_task.rerank?.cost]).toEqual([0, 0]);
    expect(run?.cost).toBeCloseTo(
      Object.values(run?.by_task ?? {}).reduce((n, s) => n + s.cost, 0),
      3,
    );
  } finally {
    await engine.close();
    await gateway.close();
    await rm(blobDir, { recursive: true, force: true });
  }
});

test("a run reports its own calls, and its budgets count the earlier runs the durable sink holds", async () => {
  const call = (amount: number, budget_key: string): UsageRecord => ({
    request_id: `req_${amount}`,
    at: new Date().toISOString(),
    operation: "complete",
    budget_key,
    sensitivity: "internal",
    status: "ok",
    usage: { input_tokens: 1000, output_tokens: 100 },
    cost: { amount, currency: "USD" },
    latency_ms: 1,
  });
  const durable = new MemoryUsage();
  await durable.record(call(4, "tenant:t/extraction")); // this morning's run
  const usage = new RunUsage(durable);
  await usage.record(call(0.5, "tenant:t/retrieval"));
  expect(usage.records.map((r) => r.cost.amount)).toEqual([0.5]);
  expect(durable.records.map((r) => r.cost.amount)).toEqual([4, 0.5]);
  expect(await usage.spentMatching("*", undefined)).toBe(4.5);
  expect(await usage.spent("tenant:t/retrieval", undefined)).toBe(0.5);
});
