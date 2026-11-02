import type { ChatMessage } from "@inspiration/contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AnthropicProvider, type ModelConfig, ProviderError, parseGatewayConfig } from "../src/index.ts";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const CONFIG = parseGatewayConfig({
  providers: [
    {
      name: "anthropic",
      kind: "anthropic",
      max_sensitivity: "internal",
      api_key_env: "TEST_ANTHROPIC_KEY",
      max_retries: 0,
      models: [
        {
          name: "claude-haiku-5-5",
          operations: ["complete"],
          json_schema: false,
          request: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
        },
      ],
    },
  ],
});
const PROVIDER = CONFIG.providers[0] as (typeof CONFIG.providers)[number];
const HAIKU = PROVIDER.models[0] as ModelConfig;
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Answer from the sources." },
  { role: "user", content: "What is the hotel cap?" },
];

beforeEach(() => {
  process.env.TEST_ANTHROPIC_KEY = "sk-ant-test";
});
afterEach(() => {
  delete process.env.TEST_ANTHROPIC_KEY;
});

function provider(handler: Handler) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return handler(url, init ?? {});
  };
  return { p: new AnthropicProvider(PROVIDER, undefined, { fetch: fetch as typeof globalThis.fetch }), seen };
}

function reply(content: unknown[], usage: Record<string, number> = {}, stop = "end_turn"): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  });
}

test("a completion sends the system text apart, the model's request fields, and no sampling", async () => {
  const { p, seen } = provider(() =>
    reply(
      [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: '{"answer": ' },
        { type: "text", text: '"650 yuan"}' },
      ],
      { input_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
    ),
  );
  const out = await p.complete(HAIKU, MESSAGES, { temperature: 0, maxOutputTokens: 256, jsonMode: true });
  const req = seen[0] as (typeof seen)[number];
  expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  // The SDK decides how the key is sent; it is sent.
  expect([req.headers.get("x-api-key"), req.headers.get("authorization")].join(" ")).toContain("sk-ant-test");
  expect(req.headers.get("anthropic-version")).toBeTruthy();
  expect(req.body).toEqual({
    model: "claude-haiku-5-5",
    max_tokens: 256,
    system: "Answer from the sources.",
    messages: [{ role: "user", content: "What is the hotel cap?" }],
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
  });
  // Thinking is left out of the text; cache reads count as cached input, and writes as input.
  expect(out).toEqual({
    text: '{"answer": "650 yuan"}',
    finishReason: "stop",
    usage: { input_tokens: 1060, output_tokens: 3, cached_input_tokens: 1000 },
  });
});

test("stop reasons map to finish reasons", async () => {
  for (const [stop, finish] of [
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
    ["end_turn", "stop"],
  ] as const) {
    const { p } = provider(() => reply([{ type: "text", text: "x" }], {}, stop));
    expect((await p.complete(HAIKU, MESSAGES, {})).finishReason, stop).toBe(finish);
  }
});

test("rate limits and server errors are retryable, bad requests are not", async () => {
  for (const [status, retryable] of [
    [429, true],
    [529, true],
    [400, false],
  ] as const) {
    const { p } = provider(() =>
      Response.json({ type: "error", error: { type: "error", message: `status ${status}` } }, { status }),
    );
    const err = await p.complete(HAIKU, MESSAGES, {}).catch((e: unknown) => e);
    expect(err, String(status)).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable, String(status)).toBe(retryable);
    expect((err as ProviderError).status, String(status)).toBe(status);
  }
});

test("a missing key, images and other operations are refused", async () => {
  delete process.env.TEST_ANTHROPIC_KEY;
  expect(() => new AnthropicProvider(PROVIDER)).toThrow(/TEST_ANTHROPIC_KEY is not set/);
  process.env.TEST_ANTHROPIC_KEY = "sk-ant-test";
  const { p, seen } = provider(() => reply([]));
  const image = { blob_id: "b", mime_type: "image/png", size: 1, sha256: "x" };
  await expect(p.complete(HAIKU, [{ role: "user", content: "?", images: [image] as never }], {})).rejects.toThrow(
    ProviderError,
  );
  await expect(p.embed(HAIKU, ["a"], "query")).rejects.toThrow(/no embedding/);
  await expect(p.rerank(HAIKU, "q", ["a"])).rejects.toThrow(/no rerank/);
  await expect(p.ocr(HAIKU, new Uint8Array(), "image/png")).rejects.toThrow(/no OCR/);
  expect(seen).toEqual([]);
});
