import type { ChatMessage } from "@inspiration/contracts";
import { MemoryBlobStore } from "@inspiration/kernel";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type ModelConfig, OpenAICompatibleProvider, ProviderError, parseGatewayConfig } from "../src/index.ts";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const CONFIG = parseGatewayConfig({
  providers: [
    {
      name: "test",
      kind: "openai_compatible",
      max_sensitivity: "internal",
      base_url: "https://llm.example/v1/",
      api_key_env: "TEST_LLM_KEY",
      models: [
        { name: "deepseek-chat", operations: ["complete"], json_schema: true },
        { name: "qwen3-embedding", operations: ["embed"], dimensions: 3, query_instruction: "Find policy passages" },
        { name: "qwen3-reranker", operations: ["rerank"] },
      ],
    },
  ],
});
const PROVIDER = CONFIG.providers[0] as (typeof CONFIG.providers)[number];
const [CHAT, EMBED, RERANK] = PROVIDER.models as [ModelConfig, ModelConfig, ModelConfig];
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hi" },
];

beforeEach(() => {
  process.env.TEST_LLM_KEY = "sk-test";
});
afterEach(() => {
  delete process.env.TEST_LLM_KEY;
});

function provider(handler: Handler, overrides: Partial<typeof PROVIDER> = {}) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return handler(url, init ?? {});
  };
  const p = new OpenAICompatibleProvider({ ...PROVIDER, ...overrides }, new MemoryBlobStore(), {
    fetch: fetch as typeof globalThis.fetch,
    backoffMs: () => 0,
  });
  return { p, seen };
}

function chatResponse(text: string, usage: Record<string, number> = {}): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, ...usage },
  });
}

test("complete sends the schema and reads usage", async () => {
  const { p, seen } = provider(() => chatResponse('{"ok": true}', { prompt_cache_hit_tokens: 4 }));
  const schema = { type: "object" };
  const out = await p.complete(CHAT, MESSAGES, { responseSchema: schema, temperature: 0, maxOutputTokens: 64 });
  const req = seen[0] as (typeof seen)[number];
  expect(req.url).toBe("https://llm.example/v1/chat/completions");
  expect(req.headers.get("authorization")).toBe("Bearer sk-test");
  expect(req.body).toMatchObject({ model: "deepseek-chat", max_tokens: 64, temperature: 0, messages: MESSAGES });
  expect((req.body.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(schema);
  expect(out).toEqual({
    text: '{"ok": true}',
    finishReason: "stop",
    usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 4 },
  });
});

test("JSON mode without a schema", async () => {
  const { p, seen } = provider(() => chatResponse("{}"));
  await p.complete(CHAT, MESSAGES, { jsonMode: true });
  expect(seen[0]?.body.response_format).toEqual({ type: "json_object" });
});

test("images are sent as data URLs", async () => {
  const { p, seen } = provider(() => chatResponse("a chart"));
  const image = await (p.blobs as MemoryBlobStore).put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    mimeType: "image/png",
  });
  await p.complete(CHAT, [{ role: "user", content: "What is this?", images: [image] }], {});
  type Part = { type: string; text?: string; image_url?: { url: string } };
  const parts = (seen[0]?.body.messages as { content: Part[] }[] | undefined)?.[0]?.content;
  expect(parts?.[0]).toEqual({ type: "text", text: "What is this?" });
  expect(parts?.[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
});

test("server errors are retried, then succeed", async () => {
  const statuses = [503, 429, 200];
  const { p } = provider(() => {
    const status = statuses.shift();
    return status === 200 ? chatResponse("ok") : new Response("busy", { status });
  });
  expect((await p.complete(CHAT, MESSAGES, {})).text).toBe("ok");
});

test("client errors are not retried", async () => {
  const { p, seen } = provider(() => new Response("bad schema", { status: 400 }));
  const e = await p.complete(CHAT, MESSAGES, {}).catch((err: unknown) => err);
  expect(e).toBeInstanceOf(ProviderError);
  expect(e).toMatchObject({ status: 400, retryable: false });
  expect(seen).toHaveLength(1);
});

test("transport errors are retried until the retries run out", async () => {
  const { p, seen } = provider(
    () => {
      throw new TypeError("fetch failed");
    },
    { max_retries: 1 },
  );
  const e = await p.complete(CHAT, MESSAGES, {}).catch((err: unknown) => err);
  expect(e).toMatchObject({ retryable: true });
  expect(seen).toHaveLength(2);
});

test("embed orders rows and prefixes queries", async () => {
  const { p, seen } = provider(() =>
    Response.json({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      usage: { prompt_tokens: 7 },
    }),
  );
  const out = await p.embed(EMBED, ["酒店上限", "hotel cap"], "query");
  expect(out.vectors).toEqual([
    [1, 0, 0],
    [0, 1, 0],
  ]);
  expect((seen[0]?.body.input as string[] | undefined)?.[0]).toBe("Instruct: Find policy passages\nQuery:酒店上限");
  await p.embed(EMBED, ["a", "b"], "document");
  expect(seen[1]?.body.input).toEqual(["a", "b"]);
  expect(seen[1]?.body).not.toHaveProperty("dimensions");
});

test("an embedding count mismatch is retryable", async () => {
  const { p } = provider(() => Response.json({ data: [{ index: 0, embedding: [1] }] }));
  await expect(p.embed(EMBED, ["a", "b"], "document")).rejects.toMatchObject({ retryable: true });
});

test("rerank maps results back to input order", async () => {
  const { p, seen } = provider(() =>
    Response.json({
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ],
      usage: { total_tokens: 12 },
    }),
  );
  const out = await p.rerank(RERANK, "q", ["a", "b", "c"], 2);
  expect(seen[0]?.url).toBe("https://llm.example/v1/rerank");
  expect(seen[0]?.body.top_n).toBe(2);
  expect(out.scores).toEqual([0.1, 0, 0.9]);
  expect(out.usage.input_tokens).toBe(12);
});

test("a missing API key fails at startup", () => {
  delete process.env.TEST_LLM_KEY;
  expect(() => new OpenAICompatibleProvider(PROVIDER)).toThrow(/TEST_LLM_KEY is not set/);
});
