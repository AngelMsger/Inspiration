/** The provider plugin interface. Only the gateway calls providers; components call the gateway. */

import type {
  BlobStore,
  ChatMessage,
  DocBlock,
  EmbedInputType,
  FinishReason,
  TokenUsage,
} from "@inspiration/contracts";
import type { ModelConfig, ProviderConfig } from "../config.ts";

export interface ProviderCompletion {
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
}

export interface ProviderEmbedding {
  vectors: number[][];
  usage: TokenUsage;
}

export interface ProviderRerank {
  /** One score per document, in input order. */
  scores: number[];
  usage: TokenUsage;
}

export interface ProviderOcr {
  blocks: DocBlock[];
  usage: TokenUsage;
  confidence?: number;
}

export interface CompletionParams {
  /** For logging and scripted fakes; not sent to providers. */
  task?: string;
  maxOutputTokens?: number;
  temperature?: number;
  stop?: string[];
  /** Set only when the model supports native JSON Schema output. */
  responseSchema?: Record<string, unknown>;
  /** Ask for a JSON object without a schema. */
  jsonMode?: boolean;
  /** Aborted when the gateway's per-call timeout passes. */
  signal?: AbortSignal;
  /** Extra provider-specific body fields. */
  extra?: Record<string, unknown>;
}

export interface ModelProvider {
  complete(model: ModelConfig, messages: readonly ChatMessage[], params: CompletionParams): Promise<ProviderCompletion>;
  embed(model: ModelConfig, texts: readonly string[], inputType: EmbedInputType): Promise<ProviderEmbedding>;
  rerank(model: ModelConfig, query: string, documents: readonly string[], topN?: number): Promise<ProviderRerank>;
  ocr(model: ModelConfig, image: Uint8Array, mimeType: string, page?: number): Promise<ProviderOcr>;
  close(): Promise<void>;
}

/** What a model_providers plugin exports: constructed once per provider entry in the config. */
export type ModelProviderClass = new (config: ProviderConfig, blobs?: BlobStore) => ModelProvider;
