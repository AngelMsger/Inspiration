import { type ChatMessage, GatewayException, type SensitivityLabel } from "@inspiration/contracts";
import { MemoryBlobStore, registry } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import {
  FakeProvider,
  Gateway,
  type MemoryUsage,
  type MockResponder,
  type ModelConfig,
  minimalInstance,
  type ProviderConfig,
  ProviderError,
} from "../src/index.ts";
import { completionRequest, gatewayConfig, makeGateway, SCHEMA } from "./fixtures.ts";

function usageOf(gateway: { usage: unknown }): MemoryUsage {
  return gateway.usage as MemoryUsage;
}

function failingCloud(options: { retryable: boolean; status?: number }): FakeProvider {
  const cloud = gatewayConfig().providers[0];
  const fake = new FakeProvider(cloud as never);
  fake.failWith = new ProviderError("boom", options);
  return fake;
}

async function rejection(promise: Promise<unknown>): Promise<GatewayException> {
  const e = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(GatewayException);
  return e as GatewayException;
}

describe("routing", () => {
  test("internal content may use the cloud model", async () => {
    const gateway = makeGateway();
    const out = await gateway.complete(completionRequest());
    expect([out.provider, out.model]).toEqual(["cloud", "cloud-flash"]);
    expect(out.request_id).toMatch(/^req_/);
    expect(out.cost.amount).toBeGreaterThan(0);
    expect(out.cost.currency).toBe("CNY");
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
    const [rec, ...rest] = usageOf(gateway).records;
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({ status: "ok", provider: "cloud", task: "extraction.extract_claims" });
  });

  test("records whom a call is charged to, as its request names them", async () => {
    const gateway = makeGateway();
    const member = "mem_01QINGHE00000000000000LINA";
    const space = "spc_01QINGHE0000000000FINANCE";
    await gateway.complete(completionRequest("asked", { member_id: member }));
    await gateway.embed({
      texts: ["read"],
      input_type: "document",
      sensitivity: "internal",
      budget_key: "tenant:t/retrieval",
      space_id: space,
    });
    await gateway.complete(completionRequest("upkeep"));
    expect(usageOf(gateway).records.map((r) => [r.operation, r.member_id, r.space_id])).toEqual([
      ["complete", member, undefined],
      ["embed", undefined, space],
      ["complete", undefined, undefined],
    ]);
  });

  test.each<SensitivityLabel>(["confidential", "secret"])(
    "%s content never leaves the local provider",
    async (label) => {
      const gateway = makeGateway();
      const out = await gateway.complete(completionRequest("x", { sensitivity: label }));
      expect(out.provider).toBe("local");
      expect(gateway.provider<FakeProvider>("cloud").calls).toEqual([]);
    },
  );

  test("candidates respect tier and route preferences", () => {
    const gateway = makeGateway();
    const refs = (task?: string, tier: "flash" | "flagship" = "flash", label: SensitivityLabel = "internal") =>
      gateway.candidates("complete", label, task ? { tier, task } : { tier }).map((c) => c.ref);
    expect(refs("extraction.extract_claims")).toEqual(["cloud/cloud-flash", "local/local-chat"]);
    expect(refs("freshness.score_units")).toEqual(["local/local-chat", "cloud/cloud-flash"]);
    expect(refs(undefined, "flagship", "public")).toEqual(["local/local-chat"]);
  });

  test("no route is an error and is metered", async () => {
    const gateway = makeGateway({ includeLocal: false });
    const e = await rejection(gateway.complete(completionRequest("x", { sensitivity: "confidential" })));
    expect(e.code).toBe("no_route");
    expect(e.error.request_id).toMatch(/^req_/);
    expect(usageOf(gateway).records).toMatchObject([{ status: "no_route" }]);
    expect(usageOf(gateway).records[0]?.provider).toBeUndefined();
  });

  test("retryable provider errors fall back to the next candidate", async () => {
    const gateway = makeGateway({ providers: { cloud: failingCloud({ retryable: true }) } });
    const out = await gateway.complete(completionRequest());
    expect(out.provider).toBe("local");
    expect(gateway.provider<FakeProvider>("cloud").calls).toEqual([["complete", "extraction.extract_claims"]]);
  });

  test("a route that allows only its own models does not fall back, even on a retryable error", async () => {
    const config = gatewayConfig();
    config.routes = [{ match: "extraction.*", prefer: ["cloud/cloud-flash"], only: true }];
    const local = new FakeProvider(config.providers[1] as never);
    const gateway = new Gateway(config, {
      blobs: new MemoryBlobStore(),
      providers: { cloud: failingCloud({ retryable: true }), local },
    });
    expect(
      gateway.candidates("complete", "internal", { tier: "flash", task: "extraction.extract_claims" }),
    ).toHaveLength(1);
    const e = await rejection(gateway.complete(completionRequest()));
    expect(e.code).toBe("provider_error");
    expect(local.calls).toEqual([]);
    // Other tasks still fall back.
    const out = await gateway.complete(completionRequest("x", { task: "freshness.score_units" }));
    expect(out.provider).toBe("local");
  });

  test("non-retryable provider errors do not fall back", async () => {
    const gateway = makeGateway({ providers: { cloud: failingCloud({ retryable: false, status: 400 }) } });
    const e = await rejection(gateway.complete(completionRequest()));
    expect(e.code).toBe("bad_request");
    expect(gateway.provider<FakeProvider>("local").calls).toEqual([]);
    expect(usageOf(gateway).records.at(-1)?.status).toBe("error");
  });

  test("every candidate failing is a retryable provider error", async () => {
    const gateway = makeGateway({ includeLocal: false, providers: { cloud: failingCloud({ retryable: true }) } });
    const e = await rejection(gateway.complete(completionRequest()));
    expect(e.code).toBe("provider_error");
    expect(e.error.retryable).toBe(true);
  });

  test("a slow provider times out and falls back", async () => {
    const slow = new FakeProvider(gatewayConfig().providers[0] as never);
    slow.delayMs = 1000;
    const gateway = makeGateway({ providers: { cloud: slow } });
    const out = await gateway.complete(completionRequest("x", { timeout_s: 0.05 }));
    expect(out.provider).toBe("local");
  });

  test("an invalid request is a bad request", async () => {
    const gateway = makeGateway();
    const e = await rejection(gateway.complete(completionRequest("x", { task: "extraction" })));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("/task: must match pattern");
  });
});

describe("budgets and cache", () => {
  test("the budget is enforced from metered cost", async () => {
    const gateway = makeGateway();
    const longText = "word ".repeat(200); // about 250 tokens: more than the 0.00001 CNY cap at 1 CNY per million
    const first = await gateway.complete(completionRequest(longText, { budget_key: "tenant:capped/extraction" }));
    expect(first.cost.amount).toBeGreaterThan(0.00001);
    const e = await rejection(gateway.complete(completionRequest("again", { budget_key: "tenant:capped/extraction" })));
    expect(e.code).toBe("budget_exceeded");
    expect(usageOf(gateway).records.at(-1)?.status).toBe("budget_exceeded");
    // Other budget keys are unaffected.
    await gateway.complete(completionRequest("again", { budget_key: "tenant:other/extraction" }));
  });

  test("a pooled budget holds for all the keys it matches together", async () => {
    const config = {
      ...gatewayConfig(),
      budgets: [{ match: "tenant:a/*", period: "day" as const, limit: 0.0003, pooled: true }],
    };
    const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
    const gateway = new Gateway(config, { providers });
    const longText = "word ".repeat(200); // about 250 tokens, 0.00025 CNY
    await gateway.complete(completionRequest(longText, { budget_key: "tenant:a/extraction" }));
    await gateway.complete(completionRequest(`${longText}more`, { budget_key: "tenant:a/retrieval" }));
    // Each key spent less than the limit on its own; together they spent more.
    const e = await rejection(gateway.complete(completionRequest("again", { budget_key: "tenant:a/page-compiler" })));
    expect(e.code).toBe("budget_exceeded");
    await gateway.complete(completionRequest("again", { budget_key: "tenant:b/extraction" }));
  });

  test("every budget that matches a key holds: a company's own and one pooled over all", async () => {
    const config = {
      ...gatewayConfig(),
      budgets: [
        { match: "tenant:*/extraction", period: "day" as const, limit: 0.0003 },
        { match: "tenant:*", period: "month" as const, limit: 0.0006, pooled: true },
      ],
    };
    const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
    const gateway = new Gateway(config, { providers });
    const longText = "word ".repeat(200); // about 250 tokens, 0.00025 CNY
    // Company a spends past its day budget; company b is still under its own.
    await gateway.complete(completionRequest(longText, { budget_key: "tenant:a/extraction" }));
    await gateway.complete(completionRequest(`${longText}more`, { budget_key: "tenant:a/extraction" }));
    const own = await rejection(gateway.complete(completionRequest("again", { budget_key: "tenant:a/extraction" })));
    expect([own.code, own.message]).toEqual(["budget_exceeded", expect.stringContaining("tenant:a/extraction")]);
    await gateway.complete(completionRequest(`${longText}b`, { budget_key: "tenant:b/extraction" }));
    // Together they spent the pooled month: b is refused below its own day budget, on any key.
    const pooled = await rejection(gateway.complete(completionRequest("again", { budget_key: "tenant:b/retrieval" })));
    expect([pooled.code, pooled.message]).toEqual(["budget_exceeded", expect.stringContaining("budget tenant:* ")]);
    // How each budget stands, as a company's usage page shows it: its own day, the pooled month.
    const keys = ["tenant:b/extraction", "tenant:b/retrieval"];
    const status = await gateway.budgetStatus(keys);
    expect(status.map((s) => [s.budget_key, s.period, s.limit])).toEqual([
      ["tenant:b/extraction", "day", 0.0003],
      ["tenant:*", "month", 0.0006],
    ]);
    expect(status[0]?.spent).toBeCloseTo(
      usageOf(gateway).spentWhere((k) => k === keys[0], undefined),
      8,
    );
    expect(status[1]?.spent).toBeCloseTo(
      usageOf(gateway).spentWhere(() => true, undefined),
      8,
    );
  });

  test("sums a tenant's calls by day and by whom they are charged to, in the gateway's clock and zone", async () => {
    let now = new Date("2026-11-30T15:30:00Z"); // 23:30 on the 30th in Shanghai
    const gateway = makeGateway({ clock: () => now });
    const member = {
      budget_key: "tenant:ten_0000000A/retrieval",
      tenant_id: "ten_0000000A",
      member_id: "mem_01QINGHE0000LINA",
    };
    const space = {
      budget_key: "tenant:ten_0000000A/extraction",
      tenant_id: "ten_0000000A",
      space_id: "spc_01QINGHE00FINANCE",
    };
    const a = await gateway.complete(completionRequest("one", member));
    const b = await gateway.complete(completionRequest("two", member));
    const c = await gateway.complete(completionRequest("three", space));
    await gateway.complete(
      completionRequest("elsewhere", { budget_key: "tenant:ten_0000000B/retrieval", tenant_id: "ten_0000000B" }),
    );
    now = new Date("2026-11-30T16:30:00Z"); // 00:30 on 1 December in Shanghai
    const d = await gateway.complete(completionRequest("four", member));
    expect(usageOf(gateway).records[0]?.at).toBe("2026-11-30T15:30:00.000Z");
    const charges = (from: string, until: string) =>
      gateway.usage.charges("ten_0000000A", new Date(from), new Date(until), gateway.timeZone);
    const all = await charges("2026-11-01T00:00:00+08:00", "2026-12-02T00:00:00+08:00");
    expect(all.map((x) => [x.date, x.member_id, x.space_id, x.calls])).toEqual([
      ["2026-11-30", member.member_id, undefined, 2],
      ["2026-11-30", undefined, space.space_id, 1],
      ["2026-12-01", member.member_id, undefined, 1],
    ]);
    expect(all[0]?.cost).toBeCloseTo(a.cost.amount + b.cost.amount, 8);
    expect(all[1]?.cost).toBeCloseTo(c.cost.amount, 8);
    expect(all[2]?.cost).toBeCloseTo(d.cost.amount, 8);
    expect(await charges("2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00")).toHaveLength(2);
  });

  test("calls started together stop at the limit, as calls one after another would", async () => {
    const config = { ...gatewayConfig(), budgets: [{ match: "tenant:a/*", period: "day" as const, limit: 0.0003 }] };
    const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
    const gateway = new Gateway(config, { providers });
    const key = { budget_key: "tenant:a/extraction" };
    // Each call holds its input and 1,000 output tokens while in flight: 0.00225 CNY, past the limit.
    const calls = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => gateway.complete(completionRequest(`${"word ".repeat(200)}${n}`, key))),
    );
    expect(calls.map((c) => c.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected", "rejected"]);
    expect((calls[1] as PromiseRejectedResult).reason).toMatchObject({ code: "budget_exceeded" });
    // Once they are done only what was spent counts: the one call spent less than the limit, so
    // the next call runs, and the one after it does not.
    await gateway.complete(completionRequest(`${"word ".repeat(200)}6`, key));
    const after = await rejection(gateway.complete(completionRequest("again", key)));
    expect([after.code, after.message.includes("in flight")]).toEqual(["budget_exceeded", false]);
    // A key under no limit holds nothing.
    await gateway.complete(completionRequest("again", { budget_key: "tenant:b/extraction" }));
  });

  test("deterministic completions are cached", async () => {
    const gateway = makeGateway();
    const first = await gateway.complete(completionRequest("same prompt"));
    const second = await gateway.complete(completionRequest("same prompt"));
    expect([first.cached, second.cached]).toEqual([false, true]);
    expect(second.text).toBe(first.text);
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.cost.amount).toBe(0);
    expect([second.provider, second.model]).toEqual(["cloud", "cloud-flash"]);
    expect(gateway.provider<FakeProvider>("cloud").calls).toHaveLength(1);
    expect(usageOf(gateway).records.map((r) => r.status)).toEqual(["ok", "cached"]);
  });

  test("sampled completions are not cached", async () => {
    const gateway = makeGateway();
    await gateway.complete(completionRequest("same prompt", { temperature: 0.7 }));
    await gateway.complete(completionRequest("same prompt", { temperature: 0.7 }));
    expect(gateway.provider<FakeProvider>("cloud").calls).toHaveLength(2);
  });

  test("the cache key changes with everything that changes the answer", () => {
    const gateway = makeGateway();
    const [candidate] = gateway.candidates("complete", "internal", { tier: "flash" });
    if (!candidate) throw new Error("no candidate");
    const base = gateway.cacheKey(candidate, completionRequest("a"));
    expect(base).toBeDefined();
    expect(gateway.cacheKey(candidate, completionRequest("b"))).not.toBe(base);
    expect(gateway.cacheKey(candidate, completionRequest("a", { prompt_version: "claims@2" }))).not.toBe(base);
    expect(gateway.cacheKey(candidate, completionRequest("a", { response_schema: SCHEMA }))).not.toBe(base);
    expect(gateway.cacheKey(candidate, completionRequest("a", { use_cache: false }))).toBeUndefined();
  });

  test("a model's request fields reach the provider and change the cache key", async () => {
    const config = gatewayConfig({ includeLocal: false });
    const cloud = config.providers[0] as ProviderConfig;
    const [flash, ...rest] = cloud.models as [ModelConfig, ...ModelConfig[]];
    const off: ProviderConfig = {
      ...cloud,
      models: [{ ...flash, request: { thinking: { type: "disabled" } } }, ...rest],
    };
    const provider = new FakeProvider(off);
    const sent: unknown[] = [];
    const complete = provider.complete.bind(provider);
    provider.complete = (model, messages, params) => {
      sent.push(params.extra);
      return complete(model, messages, params);
    };
    const gateway = new Gateway({ ...config, providers: [off] }, { providers: { cloud: provider } });
    await gateway.complete(completionRequest("a"));
    expect(sent).toEqual([{ thinking: { type: "disabled" } }]);

    const plain = makeGateway({ includeLocal: false });
    const [withRequest] = gateway.candidates("complete", "internal", { tier: "flash" });
    const [without] = plain.candidates("complete", "internal", { tier: "flash" });
    if (!withRequest || !without) throw new Error("no candidate");
    expect(gateway.cacheKey(withRequest, completionRequest("a"))).not.toBe(
      plain.cacheKey(without, completionRequest("a")),
    );
  });

  test("a metering failure does not hide the result", async () => {
    const gateway = makeGateway({
      usage: {
        record: async () => {
          throw new Error("database down");
        },
        spent: async () => 0,
        spentMatching: async () => 0,
        charges: async () => [],
      },
    });
    expect((await gateway.complete(completionRequest())).text).toBeTruthy();
  });
});

describe("structured output", () => {
  test("is parsed and validated", async () => {
    const gateway = makeGateway();
    const seen: (readonly ChatMessage[])[] = [];
    gateway.provider<FakeProvider>("cloud").script("extraction.extract_claims", (messages) => {
      seen.push(messages);
      return 'Sure:\n```json\n{"claims": ["Hotel cap is 600 CNY"]}\n```';
    });
    const out = await gateway.complete(completionRequest("x", { response_schema: SCHEMA }));
    expect(out.json).toEqual({ claims: ["Hotel cap is 600 CNY"] });
    // cloud-flash has no native JSON Schema mode, so the gateway adds the schema as an instruction.
    const last = seen[0]?.at(-1);
    expect(last?.role).toBe("system");
    expect(last?.content).toContain("JSON Schema");
  });

  test("invalid output gets one corrective retry, and both attempts are charged", async () => {
    const gateway = makeGateway();
    const fake = gateway.provider<FakeProvider>("cloud");
    fake.script("extraction.extract_claims", '{"claims": "not a list"}', '{"claims": ["fixed"]}');
    const out = await gateway.complete(completionRequest("x", { response_schema: SCHEMA }));
    expect(out.json).toEqual({ claims: ["fixed"] });
    expect(fake.calls).toHaveLength(2);
    const [rec] = usageOf(gateway).records;
    expect(rec?.usage.input_tokens).toBe(out.usage.input_tokens);
    expect(out.usage.input_tokens).toBeGreaterThan(0);
  });

  test("output invalid twice fails and is charged", async () => {
    const gateway = makeGateway();
    gateway.provider<FakeProvider>("cloud").script("extraction.extract_claims", "no json here", "[1, 2]");
    const e = await rejection(gateway.complete(completionRequest("x", { response_schema: SCHEMA })));
    expect(e.code).toBe("invalid_output");
    const [rec] = usageOf(gateway).records;
    expect(rec?.status).toBe("invalid_output");
    expect(rec?.usage.input_tokens).toBeGreaterThan(0);
    expect(rec?.cost.amount).toBeGreaterThan(0);
  });

  test("the fake provider satisfies schemas without a script", async () => {
    const out = await makeGateway().complete(
      completionRequest("x", { response_schema: SCHEMA, sensitivity: "secret" }),
    );
    expect(out.provider).toBe("local");
    expect(out.json).toEqual({ claims: [] });
  });

  test("a provider with options.mocks answers through the task's model_mocks plugin", async () => {
    const echo: MockResponder = (messages, { task }) => JSON.stringify({ claims: [task, messages.at(-1)?.content] });
    registry("model_mocks").register("test.echo_claims", echo, { replace: true });
    const request = completionRequest("x", {
      task: "test.echo_claims",
      response_schema: SCHEMA,
      sensitivity: "secret",
    });
    const local = gatewayConfig().providers.find((p) => p.name === "local") as ProviderConfig;
    const mocked = makeGateway({ providers: { local: new FakeProvider({ ...local, options: { mocks: true } }) } });
    expect((await mocked.complete(request)).json).toEqual({ claims: ["test.echo_claims", "x"] });
    expect((await makeGateway().complete(request)).json).toEqual({ claims: [] });
  });

  test("minimalInstance covers common shapes", () => {
    const schema = {
      type: "object",
      required: ["a", "b", "c", "d"],
      properties: {
        a: { const: "x" },
        b: { enum: ["p", "q"] },
        c: { type: "array", minItems: 1, items: { type: "integer", minimum: 3 } },
        d: { type: ["null", "string"], minLength: 2 },
      },
    };
    expect(minimalInstance(schema)).toEqual({ a: "x", b: "p", c: [3], d: "xx" });
  });
});

describe("embed, rerank, ocr", () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);

  test("embed routes by sensitivity and returns unit vectors", async () => {
    const gateway = makeGateway();
    const texts: [string, ...string[]] = [
      "hotel standard 600 yuan a night on trips",
      "on trips: hotel standard, 600 yuan a night",
      "quarterly revenue report",
    ];
    const out = await gateway.embed({ texts, input_type: "document", sensitivity: "internal", budget_key: "k" });
    expect([out.provider, out.model, out.dimensions]).toEqual(["cloud", "cloud-embed", 64]);
    for (const v of out.vectors) expect(dot(v, v)).toBeCloseTo(1, 6);
    const [a, b, c] = out.vectors as [number[], number[], number[]];
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    const secret = await gateway.embed({ texts: ["x"], input_type: "query", sensitivity: "secret", budget_key: "k" });
    expect(secret.provider).toBe("local");
  });

  test("rerank scores follow input order", async () => {
    const gateway = makeGateway();
    const documents: [string, ...string[]] = [
      "quarterly revenue",
      "hotel cap for travel",
      "travel hotel cap per night",
    ];
    const out = await gateway.rerank({
      query: "travel hotel cap",
      documents,
      sensitivity: "confidential",
      budget_key: "k",
    });
    expect(out.provider).toBe("local");
    const [s0, s1, s2] = out.scores as [number, number, number];
    expect(s0).toBeLessThan(s1);
    expect(s0).toBeLessThan(s2);
    expect(usageOf(gateway).records.at(-1)?.operation).toBe("rerank");
  });

  function cachingGateway(operations: ("complete" | "embed" | "rerank")[]) {
    const config = gatewayConfig();
    const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
    const sent: string[][] = [];
    for (const provider of Object.values(providers)) {
      const embed = provider.embed.bind(provider);
      provider.embed = (model, texts, inputType) => {
        sent.push([...texts]);
        return embed(model, texts, inputType);
      };
      const rerank = provider.rerank.bind(provider);
      provider.rerank = (model, query, documents) => {
        sent.push([...documents]);
        return rerank(model, query, documents);
      };
    }
    return { gateway: new Gateway({ ...config, cache: { ...config.cache, operations } }, { providers }), sent };
  }

  test("embeddings are cached per text when the config says, and only the texts it misses are sent", async () => {
    const { gateway, sent } = cachingGateway(["complete", "embed"]);
    const req = { input_type: "document" as const, sensitivity: "internal" as const, budget_key: "k" };
    const first = await gateway.embed({ ...req, texts: ["alpha", "beta"] });
    const second = await gateway.embed({ ...req, texts: ["beta", "gamma", "alpha"] });
    expect(sent).toEqual([["alpha", "beta"], ["gamma"]]);
    expect(second.vectors[0]).toEqual(first.vectors[1]);
    expect(second.vectors[2]).toEqual(first.vectors[0]);
    expect(second.dimensions).toBe(64);
    // A query is embedded apart from a document, and a call the cache answers whole costs nothing.
    await gateway.embed({ ...req, input_type: "query", texts: ["alpha"] });
    const third = await gateway.embed({ ...req, texts: ["gamma", "alpha"] });
    expect(sent).toEqual([["alpha", "beta"], ["gamma"], ["alpha"]]);
    expect(third.cost.amount).toBe(0);
    expect(usageOf(gateway).records.map((r) => r.status)).toEqual(["ok", "ok", "ok", "cached"]);
  });

  test("rerank scores are cached per document, unless top_n leaves some out", async () => {
    const { gateway, sent } = cachingGateway(["rerank"]);
    const req = { query: "travel hotel cap", sensitivity: "confidential" as const, budget_key: "k" };
    const first = await gateway.rerank({ ...req, documents: ["hotel cap for travel", "quarterly revenue"] });
    const second = await gateway.rerank({ ...req, documents: ["quarterly revenue", "travel hotel cap per night"] });
    expect(sent).toEqual([["hotel cap for travel", "quarterly revenue"], ["travel hotel cap per night"]]);
    expect(second.scores[0]).toBe(first.scores[1]);
    await gateway.rerank({ ...req, query: "revenue", documents: ["quarterly revenue"] });
    await gateway.rerank({ ...req, documents: ["quarterly revenue"], top_n: 1 });
    expect(sent.slice(2)).toEqual([["quarterly revenue"], ["quarterly revenue"]]);
    // Completions are cached only when the config lists them.
    await gateway.complete(completionRequest("same prompt", { sensitivity: "confidential" }));
    const again = await gateway.complete(completionRequest("same prompt", { sensitivity: "confidential" }));
    expect(again.cached).toBe(false);
  });

  test("by default only completions are cached", async () => {
    const gateway = makeGateway();
    expect(gateway.config.cache.operations).toEqual(["complete"]);
    const req = { texts: ["alpha"] as [string], input_type: "document" as const, sensitivity: "internal" as const };
    await gateway.embed({ ...req, budget_key: "k" });
    await gateway.embed({ ...req, budget_key: "k" });
    expect(gateway.provider<FakeProvider>("cloud").calls).toEqual([
      ["embed", undefined],
      ["embed", undefined],
    ]);
  });

  test("ocr reads the image from the blob store", async () => {
    const blobs = new MemoryBlobStore();
    const gateway = makeGateway({ blobs });
    const page =
      "# Travel policy\n\nHotels at most 600 yuan a night.\n\n| City | Cap |\n|---|---|\n| Beijing | 600 |\n\n- Tier-1 cities\n- Other cities";
    const image = await blobs.put(new TextEncoder().encode(page), { mimeType: "image/png" });
    const out = await gateway.ocr({ image, page: 3, sensitivity: "secret", budget_key: "k" });
    expect([out.provider, out.model]).toEqual(["local", "local-ocr"]);
    expect(out.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "table", "list_item", "list_item"]);
    expect(out.blocks.every((b) => b.page === 3 && b.anchor.startsWith("p3-"))).toBe(true);
    expect(new Set(out.blocks.map((b) => b.anchor)).size).toBe(out.blocks.length);
  });
});
