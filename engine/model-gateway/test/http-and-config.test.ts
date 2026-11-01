import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayException } from "@inspiration/contracts";
import { MemoryBlobStore } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import {
  budgetFor,
  createApp,
  FakeProvider,
  Gateway,
  globMatch,
  HttpModelGateway,
  loadGatewayConfig,
  MemoryCache,
  MemoryUsage,
  OpenAICompatibleProvider,
  Prompt,
  PromptRegistry,
  type ProviderConfig,
  parseGatewayConfig,
  periodStart,
  preferredModels,
  standIn,
} from "../src/index.ts";
import { completionRequest, makeGateway } from "./fixtures.ts";

const DEV_CONFIG = fileURLToPath(new URL("../../../config/gateway.dev.yaml", import.meta.url));
const DEEPSEEK_CONFIG = fileURLToPath(new URL("../../../config/gateway.deepseek.yaml", import.meta.url));
const SEARCH_ONLY_CONFIG = fileURLToPath(new URL("../../../config/gateway.local-embeddings.yaml", import.meta.url));
const HAIKU_CONFIG = fileURLToPath(new URL("../../../config/gateway.haiku.yaml", import.meta.url));
const LUNA_CONFIG = fileURLToPath(new URL("../../../config/gateway.luna.yaml", import.meta.url));

/** A client whose requests go straight to the app, without a socket. */
function clientFor(gateway: Gateway): HttpModelGateway {
  const app = createApp(gateway);
  return new HttpModelGateway("http://gateway", { fetch: async (input, init) => app.request(input as string, init) });
}

describe("HTTP service", () => {
  test("the client speaks the same interface", async () => {
    const client = clientFor(makeGateway());
    const out = await client.complete(completionRequest("hello over http"));
    expect(out.provider).toBe("cloud");
    expect(out.text).toMatch(/^fake completion/);
    const emb = await client.embed({
      texts: ["a", "b"],
      input_type: "query",
      sensitivity: "internal",
      budget_key: "k",
    });
    expect(emb.vectors).toHaveLength(2);
    expect(emb.dimensions).toBe(64);
    const rr = await client.rerank({ query: "a", documents: ["a", "b"], sensitivity: "public", budget_key: "k" });
    expect(rr.scores).toHaveLength(2);
  });

  test("ocr over HTTP", async () => {
    const blobs = new MemoryBlobStore();
    const client = clientFor(makeGateway({ blobs }));
    const image = await blobs.put(new TextEncoder().encode("# Title\n\nBody"), { mimeType: "image/png" });
    const out = await client.ocr({ image, sensitivity: "secret", budget_key: "k" });
    expect(out.blocks.map((b) => b.text)).toEqual(["Title", "Body"]);
  });

  test("errors become GatewayExceptions with the request ID", async () => {
    const client = clientFor(makeGateway({ includeLocal: false }));
    const e = await client.complete(completionRequest("x", { sensitivity: "secret" })).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GatewayException);
    expect((e as GatewayException).code).toBe("no_route");
    expect((e as GatewayException).error.request_id).toMatch(/^req_/);
  });

  test("budget status, health and request validation", async () => {
    const gateway = makeGateway();
    const app = createApp(gateway);
    await gateway.complete(completionRequest("word ".repeat(200), { budget_key: "tenant:capped/extraction" }));
    const status = (await (await app.request("/v1/budgets/tenant:capped/extraction")).json()) as { spent: number };
    expect(status).toMatchObject({ period: "month", limit: 0.00001, currency: "CNY" });
    expect(status.spent).toBeGreaterThan(0.00001);

    const post = (body: unknown) =>
      app.request("/v1/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const capped = await post(completionRequest("x", { budget_key: "tenant:capped/extraction" }));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ code: "budget_exceeded" });
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true, providers: ["cloud", "local"] });
    const bad = await post({ task: "not dotted" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { message: string }).message).toContain("must have required property 'messages'");
  });
});

describe("config", () => {
  test("the development config loads and routes", async () => {
    const config = loadGatewayConfig(DEV_CONFIG);
    const gateway = await Gateway.create(config);
    expect(config.providers.map((p) => p.name).sort()).toEqual(["cloud", "local"]);
    expect(budgetFor(config, "tenant:ten_x/extraction")?.limit).toBe(5000);
    expect(preferredModels(config, "extraction.mine_approvals")).toEqual(["local/fake-local-chat"]);
    expect(Object.keys(gateway.providers).sort()).toEqual(["cloud", "local"]);
    const out = await gateway.complete(completionRequest("x", { task: "extraction.mine_approvals" }));
    expect(out.provider).toBe("local");
  });

  test("defaults are filled in and mistakes are refused", () => {
    const config = parseGatewayConfig({
      providers: [
        { name: "p", kind: "fake", max_sensitivity: "public", models: [{ name: "m", operations: ["embed"] }] },
      ],
    });
    expect(config.currency).toBe("CNY");
    expect(config.providers[0]).toMatchObject({ timeout_s: 60, max_retries: 2, options: {} });
    expect(config.providers[0]?.models[0]).toMatchObject({
      tiers: [],
      json_schema: false,
      price: { input: 0, output: 0 },
    });
    expect(config.cache).toEqual({ backend: "memory", ttl_s: 604800, max_entries: 10000, operations: ["complete"] });
    expect(() => parseGatewayConfig({ providers: [{ name: "p" }] })).toThrow(/must have required property 'kind'/);
    expect(() => parseGatewayConfig({ providers: [], routes: [{ match: "x.*", prefer: ["nowhere/model"] }] })).toThrow(
      /unknown model nowhere\/model/,
    );
  });

  test("the search-only config gives each task one model, so a failed DeepSeek call never reaches the stand-in", () => {
    const config = loadGatewayConfig(SEARCH_ONLY_CONFIG);
    const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
    const gateway = new Gateway(config, { providers, cache: new MemoryCache(10) });
    const refs = (operation: "complete" | "embed" | "rerank", task?: string) =>
      gateway.candidates(operation, "internal", { tier: "flash", ...(task ? { task } : {}) }).map((c) => c.ref);
    expect(refs("complete", "extraction.extract_claims")).toEqual(["deepseek/deepseek-flash"]);
    expect(refs("complete", "retrieval.write_context")).toEqual(["deepseek/deepseek-flash"]);
    expect(refs("complete", "page-compiler.name_topics")).toEqual(["local/fake-local-chat"]);
    // Translating every question would be paid for; the stand-in translates none.
    expect(refs("complete", "retrieval.translate_question")).toEqual(["local/fake-local-chat"]);
    expect(refs("embed")).toEqual(["embeddings/qwen3-embedding-0.6b"]);
    expect(refs("rerank")).toEqual(["reranker/bge-reranker-v2-m3"]);
  });

  test.each([
    {
      name: "Haiku",
      file: HAIKU_CONFIG,
      model: "anthropic/claude-haiku-5-5",
      limit: 1,
      request: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
    },
    { name: "Luna", file: LUNA_CONFIG, model: "openai/gpt-6-luna", limit: 0.5, request: { reasoning_effort: "none" } },
  ])(
    "the $name config answers on its fast model and replays everything else",
    async ({ file, model, limit, request }) => {
      const config = loadGatewayConfig(file);
      const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)]));
      const gateway = new Gateway(config, { providers, cache: new MemoryCache(10) });
      const refs = (operation: "complete" | "embed" | "rerank", task?: string) =>
        gateway.candidates(operation, "internal", { tier: "flash", ...(task ? { task } : {}) }).map((c) => c.ref);
      expect(refs("complete", "retrieval.answer_question")).toEqual([model]);
      for (const task of ["extraction.extract_claims", "retrieval.translate_question", "page-compiler.name_topics"]) {
        expect(refs("complete", task), task).toEqual(["deepseek/deepseek-flash"]);
        expect(config.routes.find((r) => r.prefer.includes("deepseek/deepseek-flash"))?.cache_only, task).toBe(true);
      }
      expect(refs("embed")).toEqual(["embeddings/qwen3-embedding-0.6b"]);
      expect(refs("rerank")).toEqual(["reranker/bge-reranker-v2-m3"]);
      expect(budgetFor(config, "tenant:ten_x/retrieval")).toMatchObject({ period: "day", limit });
      const [provider, name] = model.split("/");
      const fast = config.providers.find((p) => p.name === provider)?.models.find((m) => m.name === name);
      expect(fast?.request).toEqual(request);
      // Luna refuses max_tokens, the only limit an OpenAI-compatible request sends.
      if (provider === "openai") expect(fast?.max_output_tokens).toBeUndefined();
    },
  );

  test.each([401, 429, 503, "transport"] as const)(
    "the search-only config replays saved replies and refuses the rest before the network (DeepSeek would give %s)",
    async (outcome) => {
      process.env.DEEPSEEK_SEARCH_ONLY_KEY = "not-a-key";
      try {
        const config = loadGatewayConfig(SEARCH_ONLY_CONFIG);
        let sent = 0;
        const fetch = async () => {
          sent++;
          if (outcome === "transport") throw new TypeError("fetch failed");
          return new Response("{}", { status: outcome });
        };
        const deepseek = config.providers.find((p) => p.name === "deepseek") as ProviderConfig;
        const providers = {
          ...Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)])),
          deepseek: new OpenAICompatibleProvider(deepseek, undefined, {
            fetch: fetch as typeof globalThis.fetch,
            backoffMs: () => 0,
          }),
        };
        const cache = new MemoryCache(10);
        const usage = new MemoryUsage();
        const gateway = new Gateway(config, { providers, cache, usage });
        const saved = completionRequest("a window an earlier run read");
        const [candidate] = gateway.candidates("complete", saved.sensitivity, { task: saved.task });
        const key = candidate && gateway.cacheKey(candidate, saved);
        const reply = { text: "saved reply", finish_reason: "stop", provider: "deepseek", model: "deepseek-flash" };
        await cache.set(key as string, JSON.stringify(reply));
        expect((await gateway.complete(saved)).text).toBe("saved reply");
        await expect(gateway.complete(completionRequest("a window no run read"))).rejects.toMatchObject({
          code: "cache_miss",
        });
        const named = await gateway.complete(completionRequest("topics", { task: "page-compiler.name_topics" }));
        expect(named.provider).toBe("local");
        expect(sent).toBe(0);
        expect(usage.records.map((r) => [r.task, r.provider, r.status])).toEqual([
          ["extraction.extract_claims", "deepseek", "cached"],
          ["extraction.extract_claims", "deepseek", "cache_miss"],
          ["page-compiler.name_topics", "local", "ok"],
        ]);
      } finally {
        delete process.env.DEEPSEEK_SEARCH_ONLY_KEY;
      }
    },
  );

  test("a dry run of the DeepSeek config prices stand-in replies, served from a prefix cache, and shares no cache", async () => {
    const config = loadGatewayConfig(DEEPSEEK_CONFIG);
    expect(config.currency).toBe("USD");
    expect(budgetFor(config, "tenant:ten_x/extraction")).toMatchObject({ period: "day", limit: 5 });
    expect(config.cache.backend).toBe("valkey");
    const dry = standIn(config);
    expect(dry.providers.map((p) => [p.name, p.kind, p.options.mocks])).toEqual([
      ["deepseek", "fake", true],
      ["embeddings", "fake", true],
      ["reranker", "fake", true],
      ["local", "fake", true],
    ]);
    expect(dry.cache.backend).toBe("memory");
    const gateway = await Gateway.create(dry);
    const corpus = "A passage of the drive. ".repeat(2000);
    const ask = (question: string) =>
      gateway.complete(completionRequest(`${corpus}\n${question}`, { task: "retrieval.answer_question" }));
    const first = await ask("What is the hotel cap?");
    const second = await ask("What is the meal allowance?");
    expect([first.provider, first.cost.currency]).toEqual(["deepseek", "USD"]);
    expect(first.usage.cached_input_tokens ?? 0).toBe(0);
    expect(second.usage.cached_input_tokens).toBeGreaterThan(0.9 * second.usage.input_tokens);
    expect(second.cost.amount).toBeLessThan(first.cost.amount / 10);
    await expect(gateway.complete(completionRequest("x", { sensitivity: "confidential" }))).rejects.toThrow(/no_route/);
  });

  test("globs match like a shell", () => {
    expect(globMatch("tenant:*", "tenant:ten_x/extraction")).toBe(true);
    expect(globMatch("extraction.mine_*", "extraction.extract_claims")).toBe(false);
    expect(globMatch("ten?nt:[ab]*", "tenant:b1")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});

test("prompts load from files, render, and refuse silent edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspiration-prompts-"));
  mkdirSync(join(dir, "extraction"));
  writeFileSync(
    join(dir, "extraction", "claims.yaml"),
    "task: extraction.extract_claims\nversion: claims@1\nsystem: Extract claims.\nuser: |\n  Title: {{title}}\n  {{chunk}}\n",
  );
  const prompts = new PromptRegistry();
  prompts.loadDir(dir);
  const messages = prompts.render("extraction.extract_claims", "claims@1", {
    title: "Travel policy",
    chunk: { text: "hotels 600 yuan" },
  });
  expect(messages[0]?.content).toBe("Extract claims.");
  expect(messages[1]?.content).toBe('Title: Travel policy\n{"text":"hotels 600 yuan"}\n');
  expect(() => prompts.render("extraction.extract_claims", "claims@1", { title: "x" })).toThrow(
    /missing variable chunk/,
  );
  expect(() =>
    prompts.register(new Prompt({ task: "extraction.extract_claims", version: "claims@1", user: "changed" })),
  ).toThrow(/different text/);
  expect(prompts.get("extraction.extract_claims", "claims@1").hash).toMatch(/^sha256:/);
});

test("budget periods start at local midnight", () => {
  const now = new Date("2026-10-22T17:30:00Z"); // 01:30 on 23 October in Shanghai
  expect(periodStart("day", now, "Asia/Shanghai")?.toISOString()).toBe("2026-10-22T16:00:00.000Z");
  expect(periodStart("month", now, "Asia/Shanghai")?.toISOString()).toBe("2026-09-30T16:00:00.000Z");
  expect(periodStart("month", now, "UTC")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  expect(periodStart("total", now, "UTC")).toBeUndefined();
});
