import { type ChatMessage, GatewayException, type SensitivityLabel } from "@inspiration/contracts";
import { MemoryBlobStore, registry } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import {
  FakeProvider,
  type MemoryUsage,
  type MockResponder,
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

  test("a metering failure does not hide the result", async () => {
    const gateway = makeGateway({
      usage: {
        record: async () => {
          throw new Error("database down");
        },
        spent: async () => 0,
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
    const texts: [string, ...string[]] = ["出差住宿标准每晚600元", "住宿标准 每晚 600 元 出差", "季度营收报告"];
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

  test("ocr reads the image from the blob store", async () => {
    const blobs = new MemoryBlobStore();
    const gateway = makeGateway({ blobs });
    const page =
      "# 差旅制度\n\n住宿标准每晚 600 元。\n\n| 城市 | 上限 |\n|---|---|\n| 北京 | 600 |\n\n- 一线城市\n- 其他城市";
    const image = await blobs.put(new TextEncoder().encode(page), { mimeType: "image/png" });
    const out = await gateway.ocr({ image, page: 3, sensitivity: "secret", budget_key: "k" });
    expect([out.provider, out.model]).toEqual(["local", "local-ocr"]);
    expect(out.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "table", "list_item", "list_item"]);
    expect(out.blocks.every((b) => b.page === 3 && b.anchor.startsWith("p3-"))).toBe(true);
    expect(new Set(out.blocks.map((b) => b.anchor)).size).toBe(out.blocks.length);
  });
});
