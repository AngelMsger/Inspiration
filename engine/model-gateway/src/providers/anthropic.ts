/**
 * Anthropic's Messages API, through the official SDK: completions only. Claude models have no
 * embedding, rerank or OCR endpoint here; those stay with the other providers.
 *
 * System messages become the request's system text and the rest its turns. Sampling
 * parameters and stop sequences are not sent: current Claude models reject temperature, and
 * the gateway asks for JSON in the prompt. A model's `request` fields are added to every
 * request, which is where a config sets thinking and effort: Claude Haiku 5.5 thinks unless
 * told not to, which bills reasoning as output and slows each call. The completion is the
 * reply's text blocks; thinking blocks are left out. Usage counts every input token, cache
 * reads among them as cached. No request asks for a cache write, so none is billed. A
 * refusal finishes as content_filter.
 */

import Anthropic from "@anthropic-ai/sdk";
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

const FINISH: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Room for an answer when the caller names no limit; the API requires one. */
export const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  /** Replaces global fetch, for tests. */
  fetch?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly config: ProviderConfig;
  readonly #client: Anthropic;

  constructor(config: ProviderConfig, _blobs?: BlobStore, options: AnthropicOptions = {}) {
    const env = config.api_key_env ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[env];
    if (!apiKey) throw new RangeError(`provider ${config.name}: environment variable ${env} is not set`);
    this.config = config;
    this.#client = new Anthropic({
      apiKey,
      // Never from the environment: ANTHROPIC_BASE_URL may point a developer's own tools elsewhere.
      baseURL: (config.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      timeout: config.timeout_s * 1000,
      maxRetries: config.max_retries,
      ...(options.fetch && { fetch: options.fetch }),
    });
  }

  static usage(u: Anthropic.Usage | undefined): TokenUsage {
    const read = Number(u?.cache_read_input_tokens ?? 0);
    const written = Number(u?.cache_creation_input_tokens ?? 0);
    return {
      input_tokens: Number(u?.input_tokens ?? 0) + read + written,
      output_tokens: Number(u?.output_tokens ?? 0),
      cached_input_tokens: read,
    };
  }

  async complete(
    model: ModelConfig,
    messages: readonly ChatMessage[],
    params: CompletionParams,
  ): Promise<ProviderCompletion> {
    if (messages.some((m) => m.images?.length)) {
      throw new ProviderError(`${this.config.name}: image input is not supported`, { retryable: false });
    }
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map(
        (m): Anthropic.MessageParam => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }),
      );
    const body = {
      model: model.name,
      max_tokens: params.maxOutputTokens ?? model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
      messages: turns,
      ...(system && { system }),
      ...model.request,
      ...params.extra,
    } as Anthropic.MessageCreateParamsNonStreaming;
    let reply: Anthropic.Message;
    try {
      reply = await this.#client.messages.create(body, params.signal ? { signal: params.signal } : {});
    } catch (e) {
      throw this.#error(e);
    }
    return {
      text: reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      usage: AnthropicProvider.usage(reply.usage),
      finishReason: FINISH[reply.stop_reason ?? ""] ?? "stop",
    };
  }

  #error(e: unknown): ProviderError {
    const name = this.config.name;
    if (e instanceof Anthropic.APIConnectionError) {
      return new ProviderError(`${name}: ${e.name}: ${e.message}`, { retryable: true, cause: e });
    }
    if (e instanceof Anthropic.APIError && e.status !== undefined) {
      const retryable = e.status === 429 || e.status >= 500;
      return new ProviderError(`${name}: HTTP ${e.status}: ${e.message.slice(0, 500)}`, {
        retryable,
        status: e.status,
        cause: e,
      });
    }
    // The caller's own deadline, or anything else the SDK raised.
    const err = e as Error;
    return new ProviderError(`${name}: ${err.name}: ${err.message}`, { retryable: true, cause: e });
  }

  async embed(_model: ModelConfig, _texts: readonly string[], _type: EmbedInputType): Promise<ProviderEmbedding> {
    throw new ProviderError(`${this.config.name}: no embedding models`, { retryable: false });
  }

  async rerank(_model: ModelConfig, _query: string, _documents: readonly string[]): Promise<ProviderRerank> {
    throw new ProviderError(`${this.config.name}: no rerank models`, { retryable: false });
  }

  async ocr(_model: ModelConfig, _image: Uint8Array, _mimeType: string): Promise<ProviderOcr> {
    throw new ProviderError(`${this.config.name}: no OCR models`, { retryable: false });
  }

  async close(): Promise<void> {}
}
