/**
 * The model gateway: the only way any component calls a model.
 *
 * For every request it checks the budget, picks candidate models that serve the operation
 * and tier and are cleared for the request's sensitivity label, tries them in order (route
 * preferences first, falling back on retryable errors), validates structured output (one
 * corrective retry), caches deterministic completions, and meters every call, including
 * failures.
 */

import { createHash } from "node:crypto";
import {
  allows,
  type BlobStore,
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  ContractError,
  canonicalJson,
  contractErrors,
  type EmbedRequest,
  type EmbedResult,
  GatewayException,
  type GatewayOperation,
  type ModelGateway,
  type ModelTier,
  type Money,
  newId,
  type OcrRequest,
  type OcrResult,
  type RerankRequest,
  type RerankResult,
  type SensitivityLabel,
  type TokenUsage,
  type UsageStatus,
} from "@inspiration/contracts";
import { logger, registry } from "@inspiration/kernel";
import { MemoryCache, type ResponseCache } from "./cache.ts";
import {
  budgetFor,
  ConfigError,
  cost,
  type GatewayConfig,
  type ModelConfig,
  type ProviderConfig,
  preferredModels,
} from "./config.ts";
import { ProviderError } from "./errors.ts";
import { budgetSpent, MemoryUsage, periodStart, type UsageSink } from "./metering.ts";
import type { CompletionParams, ModelProvider, ModelProviderClass, ProviderCompletion } from "./providers/base.ts";
import { extractJson, InvalidOutput, schemaInstruction, validateOutput } from "./structured.ts";

const log = logger("model-gateway");

export interface Candidate {
  readonly provider: ProviderConfig;
  readonly model: ModelConfig;
  /** "provider/model". */
  readonly ref: string;
}

export interface GatewayOptions {
  usage?: UsageSink;
  /** Defaults to an in-process cache unless the config's cache backend is "none". */
  cache?: ResponseCache;
  blobs?: BlobStore;
  /** Provider instances by provider name. Gateway.create builds the missing ones from plugins. */
  providers?: Record<string, ModelProvider>;
  /** Budget periods start at midnight in this zone. */
  timeZone?: string;
}

const ZERO: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: (a.cached_input_tokens ?? 0) + (b.cached_input_tokens ?? 0),
  };
}

interface Common {
  budget_key: string;
  sensitivity: SensitivityLabel;
  tenant_id?: string;
}

/** What one attempt on one candidate produced, before the gateway adds the fields only it knows. */
interface Attempt<R> {
  fields: R;
  usage: TokenUsage;
  status: UsageStatus;
  /** Set on cache hits: the model that originally answered. */
  provider?: string;
  model?: string;
}

interface Meta {
  tier?: ModelTier;
  task?: string;
  promptVersion?: string;
  withLatency?: boolean;
}

/** Run fn with an abort signal that fires after timeoutS; reject when it does, even if fn ignores it. */
async function withTimeout<T>(timeoutS: number | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (timeoutS === undefined) return fn();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError(`timed out after ${timeoutS}s`, { retryable: true }));
    }, timeoutS * 1000);
  });
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class Gateway implements ModelGateway {
  readonly config: GatewayConfig;
  readonly usage: UsageSink;
  readonly cache: ResponseCache | undefined;
  readonly blobs: BlobStore | undefined;
  readonly timeZone: string;
  readonly providers: Readonly<Record<string, ModelProvider>>;

  /** A gateway whose providers not given in options are built from the model_providers plugins. */
  static async create(config: GatewayConfig, options: GatewayOptions = {}): Promise<Gateway> {
    const providers = { ...options.providers };
    for (const p of config.providers) {
      if (providers[p.name]) continue;
      const Provider = await registry("model_providers").get<ModelProviderClass>(p.kind);
      providers[p.name] = new Provider(p, options.blobs);
    }
    return new Gateway(config, { ...options, providers });
  }

  constructor(config: GatewayConfig, options: GatewayOptions = {}) {
    this.config = config;
    this.usage = options.usage ?? new MemoryUsage();
    if (options.cache) this.cache = options.cache;
    else if (config.cache.backend === "memory") this.cache = new MemoryCache(config.cache.max_entries);
    else if (config.cache.backend === "valkey") throw new ConfigError("cache backend valkey needs a ValkeyCache");
    this.blobs = options.blobs;
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
    const providers = options.providers ?? {};
    const missing = config.providers.find((p) => !providers[p.name]);
    if (missing) throw new ConfigError(`no instance for provider ${missing.name}; use Gateway.create`);
    this.providers = providers;
  }

  /** The provider instance, for tests (FakeProvider.script) and diagnostics. */
  provider<P extends ModelProvider = ModelProvider>(name: string): P {
    const p = this.providers[name];
    if (!p) throw new RangeError(`no provider ${name}`);
    return p as P;
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.providers).map((p) => p.close()));
  }

  // ------------------------------------------------------------ routing

  candidates(
    operation: GatewayOperation,
    sensitivity: SensitivityLabel,
    options: { tier?: ModelTier; task?: string } = {},
  ): Candidate[] {
    const out: Candidate[] = [];
    for (const provider of this.config.providers) {
      if (!allows(provider.max_sensitivity, sensitivity)) continue;
      for (const model of provider.models) {
        if (!model.operations.includes(operation)) continue;
        const { tier } = options;
        if (operation === "complete" && tier && model.tiers.length && !model.tiers.includes(tier)) continue;
        out.push({ provider, model, ref: `${provider.name}/${model.name}` });
      }
    }
    const preferred = preferredModels(this.config, options.task);
    const rank = (c: Candidate) => {
      const i = preferred.indexOf(c.ref);
      return i < 0 ? preferred.length : i;
    };
    return out.sort((a, b) => rank(a) - rank(b));
  }

  // ------------------------------------------------------------ metering

  #money(amount: number): Money {
    return { amount: Number(amount.toFixed(8)), currency: this.config.currency };
  }

  async #checkBudget(budgetKey: string): Promise<void> {
    const budget = budgetFor(this.config, budgetKey);
    if (budget?.limit === undefined) return;
    const spent = await budgetSpent(
      this.usage,
      budget,
      budgetKey,
      periodStart(budget.period, new Date(), this.timeZone),
    );
    if (spent >= budget.limit) {
      throw new GatewayException(
        "budget_exceeded",
        `budget ${budgetKey} spent ${spent.toFixed(4)} of ${budget.limit} ${this.config.currency} this ${budget.period}`,
      );
    }
  }

  async #record(
    base: { requestId: string; operation: GatewayOperation; req: Common; started: number; meta: Meta },
    outcome: { status: UsageStatus; usage?: TokenUsage; cost?: number; candidate?: Candidate; error?: string },
  ): Promise<number> {
    const latency = Math.round(performance.now() - base.started);
    const rec = {
      request_id: base.requestId,
      at: new Date().toISOString(),
      tenant_id: base.req.tenant_id,
      operation: base.operation,
      task: base.meta.task,
      prompt_version: base.meta.promptVersion,
      budget_key: base.req.budget_key,
      sensitivity: base.req.sensitivity,
      provider: outcome.candidate?.provider.name,
      model: outcome.candidate?.model.name,
      status: outcome.status,
      usage: outcome.usage ?? ZERO,
      cost: this.#money(outcome.cost ?? 0),
      latency_ms: latency,
      error: outcome.error,
    };
    try {
      await this.usage.record(JSON.parse(JSON.stringify(rec)));
    } catch (error) {
      // Metering must never hide the result of the call itself.
      log.error("failed to record usage", { request: base.requestId, error });
    }
    return latency;
  }

  /**
   * Budget check, routing, fallback and metering shared by every operation. run may throw
   * ProviderError (retryable ones fall back to the next candidate) or GatewayException.
   */
  async #guarded<R extends object>(
    operation: GatewayOperation,
    req: Common,
    run: (candidate: Candidate) => Promise<Attempt<R>>,
    meta: Meta = {},
  ): Promise<R & { request_id: string; provider: string; model: string; usage: TokenUsage; cost: Money }> {
    const requestId = newId("request");
    const base = { requestId, operation, req, started: performance.now(), meta };
    try {
      await this.#checkBudget(req.budget_key);
    } catch (e) {
      if (!(e instanceof GatewayException)) throw e;
      await this.#record(base, { status: "budget_exceeded", error: e.error.message });
      e.error.request_id = requestId;
      throw e;
    }
    const candidates = this.candidates(operation, req.sensitivity, { tier: meta.tier, task: meta.task });
    if (!candidates.length) {
      const message = `no ${operation} model allowed for sensitivity ${req.sensitivity}${meta.tier ? ` and tier ${meta.tier}` : ""}`;
      await this.#record(base, { status: "no_route", error: message });
      throw new GatewayException("no_route", message, { requestId });
    }
    let lastError: Error | undefined;
    for (const candidate of candidates) {
      let attempt: Attempt<R>;
      try {
        attempt = await run(candidate);
      } catch (e) {
        if (e instanceof ProviderError) {
          lastError = e;
          log.warn("provider call failed", { operation, model: candidate.ref, error: e.message });
          if (e.retryable) continue;
          await this.#record(base, { candidate, status: "error", error: e.message });
          const code = e.status === 400 ? "bad_request" : "provider_error";
          throw new GatewayException(code, e.message, { requestId, cause: e });
        }
        if (e instanceof GatewayException) {
          const spent = e.usage ?? ZERO;
          await this.#record(base, {
            candidate,
            usage: spent,
            cost: cost(candidate.model.price, spent.input_tokens, spent.output_tokens),
            status: e.code === "invalid_output" ? "invalid_output" : "error",
            error: e.error.message,
          });
          e.error.request_id = requestId;
          throw e;
        }
        throw e;
      }
      const { usage } = attempt;
      const amount = cost(
        candidate.model.price,
        usage.input_tokens,
        usage.output_tokens,
        usage.cached_input_tokens ?? 0,
      );
      const latency = await this.#record(base, { candidate, usage, cost: amount, status: attempt.status });
      return {
        request_id: requestId,
        provider: attempt.provider ?? candidate.provider.name,
        model: attempt.model ?? candidate.model.name,
        usage,
        cost: this.#money(amount),
        ...(meta.withLatency ? { latency_ms: latency } : {}),
        ...attempt.fields,
      };
    }
    await this.#record(base, { status: "error", error: String(lastError?.message) });
    throw new GatewayException(
      "provider_error",
      `all ${candidates.length} candidates failed; last: ${lastError?.message}`,
      { requestId, cause: lastError },
    );
  }

  #validated(typeName: string, req: unknown): void {
    const errors = contractErrors(typeName, req);
    if (errors.length) throw new GatewayException("bad_request", new ContractError(typeName, errors).message);
  }

  // ------------------------------------------------------------ complete

  /** The response cache key, or undefined when this request must not be cached. */
  cacheKey(candidate: Candidate, req: CompletionRequest): string | undefined {
    if (!this.cache || req.use_cache === false || (req.temperature !== undefined && req.temperature !== 0)) {
      return undefined;
    }
    const material = canonicalJson([
      candidate.ref,
      req.task,
      req.prompt_version,
      req.messages,
      req.response_schema ?? null,
      req.max_output_tokens ?? null,
      req.stop ?? null,
    ]);
    return createHash("sha256").update(material).digest("hex");
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    this.#validated("CompletionRequest", req);
    type Fields = Pick<Completion, "text" | "json" | "finish_reason" | "cached">;
    const run = async (candidate: Candidate): Promise<Attempt<Fields>> => {
      const key = this.cacheKey(candidate, req);
      const hit = key === undefined ? undefined : await this.cache?.get(key);
      if (hit !== undefined) {
        const { provider, model, ...fields } = JSON.parse(hit) as Fields & { provider: string; model: string };
        return { fields: { ...fields, cached: true }, usage: ZERO, status: "cached", provider, model };
      }

      let messages: ChatMessage[] = [...req.messages];
      const params: CompletionParams = { task: req.task };
      const maxOutput = req.max_output_tokens ?? candidate.model.max_output_tokens;
      if (maxOutput !== undefined) params.maxOutputTokens = maxOutput;
      if (req.temperature !== undefined) params.temperature = req.temperature;
      if (req.stop) params.stop = req.stop;
      if (req.response_schema) {
        if (candidate.model.json_schema) params.responseSchema = req.response_schema;
        else {
          params.jsonMode = true;
          messages.push({ role: "system", content: schemaInstruction(req.response_schema) });
        }
      }

      const provider = this.provider(candidate.provider.name);
      let usage = ZERO;
      let parsed: unknown;
      let out: ProviderCompletion | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        out = await withTimeout(req.timeout_s, (signal) =>
          provider.complete(candidate.model, messages, signal ? { ...params, signal } : params),
        );
        usage = addUsage(usage, out.usage);
        if (!req.response_schema) break;
        try {
          parsed = extractJson(out.text);
          validateOutput(req.response_schema, parsed);
          break;
        } catch (e) {
          if (!(e instanceof InvalidOutput)) throw e;
          if (attempt === 1) {
            const failure = new GatewayException("invalid_output", e.message, { cause: e });
            failure.usage = usage; // both attempts are charged
            throw failure;
          }
          messages = [
            ...messages,
            { role: "assistant", content: out.text },
            { role: "user", content: `That output is invalid: ${e.message}. Reply again with corrected JSON only.` },
          ];
        }
      }
      const done = out as ProviderCompletion;
      const fields: Fields = { text: done.text, finish_reason: done.finishReason, cached: false };
      if (parsed !== undefined) fields.json = parsed as Completion["json"];
      if (key !== undefined && this.cache && done.finishReason === "stop") {
        const entry = { ...fields, provider: candidate.provider.name, model: candidate.model.name };
        await this.cache.set(key, JSON.stringify(entry), this.config.cache.ttl_s);
      }
      return { fields, usage, status: "ok" };
    };
    return this.#guarded("complete", req, run, {
      tier: req.tier ?? "flash",
      task: req.task,
      promptVersion: req.prompt_version,
      withLatency: true,
    }) as Promise<Completion>;
  }

  // ------------------------------------------------------------ embed, rerank, ocr

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.#validated("EmbedRequest", req);
    return this.#guarded("embed", req, async (candidate) => {
      const out = await this.provider(candidate.provider.name).embed(candidate.model, req.texts, req.input_type);
      const dimensions = out.vectors[0]?.length ?? candidate.model.dimensions ?? 0;
      return { fields: { vectors: out.vectors, dimensions }, usage: out.usage, status: "ok" };
    });
  }

  async rerank(req: RerankRequest): Promise<RerankResult> {
    this.#validated("RerankRequest", req);
    return this.#guarded("rerank", req, async (candidate) => {
      const out = await this.provider(candidate.provider.name).rerank(
        candidate.model,
        req.query,
        req.documents,
        req.top_n,
      );
      return { fields: { scores: out.scores }, usage: out.usage, status: "ok" };
    });
  }

  async ocr(req: OcrRequest): Promise<OcrResult> {
    this.#validated("OcrRequest", req);
    if (!this.blobs) throw new GatewayException("bad_request", "OCR needs a blob store");
    const image = await this.blobs.get(req.image);
    return this.#guarded("ocr", req, async (candidate) => {
      const out = await this.provider(candidate.provider.name).ocr(
        candidate.model,
        image,
        req.image.mime_type,
        req.page,
      );
      const fields: Pick<OcrResult, "blocks" | "confidence"> = { blocks: out.blocks };
      if (out.confidence !== undefined) fields.confidence = out.confidence;
      return { fields, usage: out.usage, status: "ok" };
    });
  }
}
