/**
 * OpenAI-compatible HTTP provider.
 *
 * Covers DeepSeek, Qwen (DashScope compatible mode), Zhipu, Moonshot, and local servers
 * (vLLM, SGLang, MindIE, Ollama): chat completions, embeddings, the Jina-style /rerank
 * endpoint that vLLM and SiliconFlow serve, and OCR through a vision model's chat endpoint.
 */

import type { BlobStore, ChatMessage, EmbedInputType, FinishReason, TokenUsage } from "@inspiration/contracts";
import type { ModelConfig, ProviderConfig } from "../config.ts";
import { ProviderError } from "../errors.ts";
import type {
  CompletionParams,
  ModelProvider,
  ProviderCompletion,
  ProviderEmbedding,
  ProviderOcr,
  ProviderRerank,
} from "./base.ts";
import { markdownToBlocks } from "./markdown.ts";

const FINISH: Record<string, FinishReason> = { stop: "stop", length: "length", content_filter: "content_filter" };

// biome-ignore lint/suspicious/noExplicitAny: provider response bodies are untyped JSON
type Json = any;

export interface OpenAICompatibleOptions {
  /** Replaces global fetch, for tests. */
  fetch?: typeof fetch;
  /** Wait before retry number n (0-based). Defaults to 0.5 s doubling. */
  backoffMs?: (attempt: number) => number;
}

function base64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly config: ProviderConfig;
  readonly blobs: BlobStore | undefined;
  readonly baseUrl: string;
  readonly #headers: Record<string, string> = { "content-type": "application/json" };
  readonly #fetch: typeof fetch;
  readonly #backoffMs: (attempt: number) => number;

  constructor(config: ProviderConfig, blobs?: BlobStore, options: OpenAICompatibleOptions = {}) {
    if (!config.base_url) throw new RangeError(`provider ${config.name}: base_url is required`);
    this.config = config;
    this.blobs = blobs;
    this.baseUrl = config.base_url.replace(/\/+$/, "");
    if (config.api_key_env) {
      const key = process.env[config.api_key_env];
      if (!key) throw new RangeError(`provider ${config.name}: environment variable ${config.api_key_env} is not set`);
      this.#headers.authorization = `Bearer ${key}`;
    }
    this.#fetch = options.fetch ?? fetch;
    this.#backoffMs = options.backoffMs ?? ((n) => 500 * 2 ** n);
  }

  async #post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
    const name = this.config.name;
    for (let attempt = 0; ; attempt++) {
      const last = attempt === this.config.max_retries;
      const timeout = AbortSignal.timeout(this.config.timeout_s * 1000);
      let response: Response;
      try {
        response = await this.#fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        // The caller's own deadline is final; a transport error or our timeout is retried.
        if (signal?.aborted || last) {
          throw new ProviderError(`${name}: ${(e as Error).name}: ${(e as Error).message}`, {
            retryable: true,
            cause: e,
          });
        }
        await new Promise((r) => setTimeout(r, this.#backoffMs(attempt)));
        continue;
      }
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || last) {
        const text = (await response.text()).slice(0, 500);
        throw new ProviderError(`${name}: HTTP ${response.status}: ${text}`, { retryable, status: response.status });
      }
      await response.body?.cancel();
      await new Promise((r) => setTimeout(r, this.#backoffMs(attempt)));
    }
  }

  async #message(m: ChatMessage): Promise<Json> {
    if (!m.images?.length) return { role: m.role, content: m.content };
    if (!this.blobs)
      throw new ProviderError(`${this.config.name}: image input needs a blob store`, { retryable: false });
    const parts: Json[] = [{ type: "text", text: m.content }];
    for (const ref of m.images) {
      const data = await this.blobs.get(ref);
      parts.push({ type: "image_url", image_url: { url: `data:${ref.mime_type};base64,${base64(data)}` } });
    }
    return { role: m.role, content: parts };
  }

  static usage(data: Json): TokenUsage {
    const u = data?.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    return {
      input_tokens: Number(u.prompt_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
      cached_input_tokens: Number(cached),
    };
  }

  async complete(
    model: ModelConfig,
    messages: readonly ChatMessage[],
    params: CompletionParams,
  ): Promise<ProviderCompletion> {
    const body: Json = { model: model.name, messages: await Promise.all(messages.map((m) => this.#message(m))) };
    if (params.maxOutputTokens !== undefined) body.max_tokens = params.maxOutputTokens;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stop?.length) body.stop = params.stop;
    if (params.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: params.responseSchema, strict: true },
      };
    } else if (params.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    Object.assign(body, params.extra);
    const data = await this.#post("/chat/completions", body, params.signal);
    const choice = data?.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError(`${this.config.name}: malformed completion response`, { retryable: true });
    }
    return {
      text: choice.message.content ?? "",
      usage: OpenAICompatibleProvider.usage(data),
      finishReason: FINISH[choice.finish_reason] ?? "stop",
    };
  }

  async embed(model: ModelConfig, texts: readonly string[], inputType: EmbedInputType): Promise<ProviderEmbedding> {
    const input =
      inputType === "query" && model.query_instruction
        ? texts.map((t) => `Instruct: ${model.query_instruction}\nQuery:${t}`)
        : [...texts];
    const body: Json = { model: model.name, input };
    if (model.dimensions && this.config.options.send_dimensions) body.dimensions = model.dimensions;
    const data = await this.#post("/embeddings", body);
    const rows: Json[] = [...(data?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== input.length) {
      throw new ProviderError(`${this.config.name}: expected ${input.length} embeddings, got ${rows.length}`, {
        retryable: true,
      });
    }
    return { vectors: rows.map((r) => r.embedding.map(Number)), usage: OpenAICompatibleProvider.usage(data) };
  }

  async rerank(
    model: ModelConfig,
    query: string,
    documents: readonly string[],
    topN?: number,
  ): Promise<ProviderRerank> {
    const body: Json = { model: model.name, query, documents: [...documents] };
    if (topN !== undefined) body.top_n = topN;
    const data = await this.#post(String(this.config.options.rerank_path ?? "/rerank"), body);
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of data?.results ?? []) scores[Number(r.index)] = Number(r.relevance_score ?? r.score ?? 0);
    const tokens = Number(data?.usage?.total_tokens ?? data?.usage?.prompt_tokens ?? 0);
    return { scores, usage: { input_tokens: tokens, output_tokens: 0 } };
  }

  async ocr(model: ModelConfig, image: Uint8Array, mimeType: string, page?: number): Promise<ProviderOcr> {
    const prompt = String(this.config.options.ocr_prompt ?? "OCR: convert this page to Markdown, keeping tables.");
    const url = `data:${mimeType};base64,${base64(image)}`;
    const data = await this.#post("/chat/completions", {
      model: model.name,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url } },
            { type: "text", text: prompt },
          ],
        },
      ],
      temperature: 0,
    });
    const text = data?.choices?.[0]?.message?.content ?? "";
    return { blocks: markdownToBlocks(text, page), usage: OpenAICompatibleProvider.usage(data) };
  }

  async close(): Promise<void> {}
}
