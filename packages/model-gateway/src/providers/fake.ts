/**
 * Deterministic offline provider for tests, CI and demos without a model server.
 *
 * complete: scripted replies per task (FakeProvider.script), otherwise a minimal JSON value
 * that satisfies the response schema, otherwise a fixed text derived from the prompt.
 * embed: hashed character n-grams, so texts that share words get similar vectors and
 * retrieval tests behave sensibly. rerank: n-gram overlap. ocr: the image bytes as text.
 */

import { createHash } from "node:crypto";
import type { BlobStore, ChatMessage, EmbedInputType } from "@inspiration/contracts";
import type { ModelConfig, ProviderConfig } from "../config.ts";
import { SCHEMA_MARKER } from "../structured.ts";
import type {
  CompletionParams,
  ModelProvider,
  ProviderCompletion,
  ProviderEmbedding,
  ProviderOcr,
  ProviderRerank,
} from "./base.ts";
import { markdownToBlocks } from "./markdown.ts";

export type Reply = string | ((messages: readonly ChatMessage[]) => string);

const CJK = /[一-鿿]/g;

/** Rough count: CJK characters are about one token each, other text about four characters. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = [...text].length - cjk;
  return cjk + Math.max(Math.floor(rest / 4), text ? 1 : 0);
}

/** Character unigrams and bigrams of the text without whitespace, lower-cased. */
export function ngrams(text: string): string[] {
  const chars = [...text.toLowerCase().replace(/\s/g, "")];
  const out: string[] = [];
  for (const n of [1, 2]) for (let i = 0; i + n <= chars.length; i++) out.push(chars.slice(i, i + n).join(""));
  return out;
}

type Schema = Record<string, unknown>;

/** The smallest value that satisfies common JSON Schema shapes (const, enum, required fields). */
export function minimalInstance(schema: Schema): unknown {
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) return minimalInstance((schema[key] as Schema[])[0] ?? {});
  }
  let kind = schema.type;
  if (Array.isArray(kind)) kind = kind.find((k) => k !== "null") ?? "null";
  if (kind === "object" || "properties" in schema) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const required = (schema.required ?? []) as string[];
    return Object.fromEntries(required.map((k) => [k, minimalInstance(props[k] ?? {})]));
  }
  if (kind === "array") {
    return Array.from({ length: Number(schema.minItems ?? 0) }, () => minimalInstance((schema.items ?? {}) as Schema));
  }
  if (kind === "string") return "x".repeat(Number(schema.minLength ?? 0));
  if (kind === "integer" || kind === "number") return schema.minimum ?? 0;
  if (kind === "boolean") return false;
  return null;
}

/** The schema the gateway put in the prompt for a model without native JSON Schema output. */
function instructedSchema(messages: readonly ChatMessage[]): Schema | undefined {
  for (const m of [...messages].reverse()) {
    const at = m.content.indexOf(SCHEMA_MARKER);
    if (at < 0) continue;
    try {
      const schema: unknown = JSON.parse(m.content.slice(at + SCHEMA_MARKER.length));
      return typeof schema === "object" && schema !== null && !Array.isArray(schema) ? (schema as Schema) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hashInt(text: string): bigint {
  return createHash("sha256").update(text).digest().readBigUInt64BE(0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

export class FakeProvider implements ModelProvider {
  readonly config: ProviderConfig;
  readonly blobs: BlobStore | undefined;
  /** Every call as [operation, task]. */
  readonly calls: [string, string | undefined][] = [];
  /** Delay before each completion, to exercise timeouts. */
  delayMs = 0;
  /** Make every completion fail with this error, to exercise fallback. */
  failWith: Error | undefined;
  readonly #scripts = new Map<string, Reply[]>();

  constructor(config: ProviderConfig, blobs?: BlobStore) {
    this.config = config;
    this.blobs = blobs;
  }

  /** Queue replies for a task. A reply is a string or a function of the messages. */
  script(task: string, ...replies: Reply[]): void {
    this.#scripts.set(task, [...(this.#scripts.get(task) ?? []), ...replies]);
  }

  async complete(
    _model: ModelConfig,
    messages: readonly ChatMessage[],
    params: CompletionParams,
  ): Promise<ProviderCompletion> {
    this.calls.push(["complete", params.task]);
    if (this.delayMs) await sleep(this.delayMs, params.signal);
    if (this.failWith) throw this.failWith;
    const prompt = messages.map((m) => m.content).join("\n");
    const reply = this.#scripts.get(params.task ?? "")?.shift();
    let text: string;
    if (reply !== undefined) {
      text = typeof reply === "function" ? reply(messages) : reply;
    } else if (params.responseSchema || params.jsonMode) {
      text = JSON.stringify(minimalInstance(params.responseSchema ?? instructedSchema(messages) ?? { type: "object" }));
    } else {
      text = `fake completion ${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
    }
    return {
      text,
      usage: { input_tokens: estimateTokens(prompt), output_tokens: estimateTokens(text) },
      finishReason: "stop",
    };
  }

  async embed(model: ModelConfig, texts: readonly string[], _inputType: EmbedInputType): Promise<ProviderEmbedding> {
    this.calls.push(["embed", undefined]);
    const dims = model.dimensions ?? 64;
    const vectors = texts.map((text) => {
      const v = new Array<number>(dims).fill(0);
      for (const g of ngrams(text)) {
        const h = hashInt(g);
        const i = Number(h % BigInt(dims));
        v[i] = (v[i] as number) + ((h >> 32n) & 1n ? 1 : -1);
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
    const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
    return { vectors, usage: { input_tokens: tokens, output_tokens: 0 } };
  }

  async rerank(_model: ModelConfig, query: string, documents: readonly string[]): Promise<ProviderRerank> {
    this.calls.push(["rerank", undefined]);
    const q = new Set(ngrams(query));
    const scores = documents.map((d) => {
      const g = new Set(ngrams(d));
      const union = new Set([...q, ...g]).size;
      return union ? [...q].filter((x) => g.has(x)).length / union : 0;
    });
    const tokens = estimateTokens(query) * documents.length + documents.reduce((n, d) => n + estimateTokens(d), 0);
    return { scores, usage: { input_tokens: tokens, output_tokens: 0 } };
  }

  async ocr(_model: ModelConfig, image: Uint8Array, _mimeType: string, page?: number): Promise<ProviderOcr> {
    this.calls.push(["ocr", undefined]);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(image);
    } catch {
      text = "[fake OCR text]";
    }
    return {
      blocks: markdownToBlocks(text, page),
      usage: { input_tokens: 1000, output_tokens: estimateTokens(text) },
      confidence: 0.5,
    };
  }

  async close(): Promise<void> {}
}
