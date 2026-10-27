/**
 * Gateway configuration: providers, models, routes, budgets and cache. Field names match
 * the YAML file, which uses snake_case like the contracts.
 *
 * Example (gateway.yaml):
 *
 *     currency: CNY
 *     providers:
 *       - name: deepseek
 *         kind: openai_compatible               # model_providers plugin name
 *         base_url: https://api.deepseek.com/v1
 *         api_key_env: DEEPSEEK_API_KEY
 *         max_sensitivity: internal             # never sees confidential or secret content
 *         models:
 *           - name: deepseek-v4.1-flash
 *             operations: [complete]
 *             tiers: [flash, standard]
 *             json_schema: false
 *             price: {input: 1.0, output: 2.0, cached_input: 0.2}   # per million tokens
 *       - name: local
 *         kind: openai_compatible
 *         base_url: http://gpu-node:8000/v1
 *         max_sensitivity: secret
 *         models:
 *           - {name: qwen3-embedding-0.6b, operations: [embed], dimensions: 1024}
 *           - {name: qwen3-reranker-0.6b, operations: [rerank]}
 *           - {name: paddleocr-vl, operations: [ocr]}
 *     routes:
 *       - match: "governance.*"                 # task glob
 *         prefer: [local/qwen3-30b-a3b]         # provider/model, tried first
 *     budgets:
 *       - match: "tenant:*"                     # budget_key glob; first match wins
 *         period: month
 *         limit: 5000                           # for each key it matches
 *       - match: "*"
 *         period: day
 *         limit: 5
 *         pooled: true                          # for all the keys it matches together
 */

import { readFileSync } from "node:fs";
import type { BudgetPeriod, GatewayOperation, ModelTier, SensitivityLabel } from "@inspiration/contracts";
import { schemaErrors } from "@inspiration/contracts";
import { parse } from "yaml";

/** Per million tokens, in the gateway currency. */
export interface Price {
  input: number;
  output: number;
  cached_input?: number;
}

export interface ModelConfig {
  name: string;
  operations: GatewayOperation[];
  tiers: ModelTier[];
  price: Price;
  /** Supports response_format {"type": "json_schema"}. */
  json_schema: boolean;
  /** Embedding size. */
  dimensions?: number;
  max_output_tokens?: number;
  /** Prefix for embedding queries (Qwen3-Embedding style). */
  query_instruction?: string;
}

export interface ProviderConfig {
  name: string;
  /** The model_providers plugin that implements it. */
  kind: string;
  max_sensitivity: SensitivityLabel;
  base_url?: string;
  api_key_env?: string;
  timeout_s: number;
  max_retries: number;
  options: Record<string, unknown>;
  models: ModelConfig[];
}

export interface RouteConfig {
  /** Task glob. */
  match: string;
  /** "provider/model" references, tried first. */
  prefer: string[];
}

export interface BudgetConfig {
  /** budget_key glob. */
  match: string;
  period: BudgetPeriod;
  /** Absent means unlimited, still metered. */
  limit?: number;
  /** The limit holds for every key the glob matches together, not for each key on its own. */
  pooled?: boolean;
}

export interface CacheConfig {
  backend: "none" | "memory" | "valkey";
  ttl_s: number;
  max_entries: number;
  /**
   * The operations whose replies are cached: completions by default; embeddings (per text)
   * and rerank scores (per query and document) when a real model makes them slow to redo.
   */
  operations: ("complete" | "embed" | "rerank")[];
}

export interface GatewayConfig {
  currency: string;
  providers: ProviderConfig[];
  routes: RouteConfig[];
  budgets: BudgetConfig[];
  cache: CacheConfig;
}

const SENSITIVITY = { enum: ["public", "internal", "confidential", "secret"] };

const SCHEMA = {
  type: "object",
  required: ["providers"],
  additionalProperties: false,
  properties: {
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    providers: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "kind", "max_sensitivity", "models"],
        additionalProperties: false,
        properties: {
          name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          kind: { type: "string" },
          max_sensitivity: SENSITIVITY,
          base_url: { type: "string" },
          api_key_env: { type: "string" },
          timeout_s: { type: "number", exclusiveMinimum: 0 },
          max_retries: { type: "integer", minimum: 0 },
          options: { type: "object" },
          models: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "operations"],
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                operations: { type: "array", items: { enum: ["complete", "embed", "rerank", "ocr"] } },
                tiers: { type: "array", items: { enum: ["flash", "standard", "flagship"] } },
                price: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    input: { type: "number", minimum: 0 },
                    output: { type: "number", minimum: 0 },
                    cached_input: { type: "number", minimum: 0 },
                  },
                },
                json_schema: { type: "boolean" },
                dimensions: { type: "integer", minimum: 1 },
                max_output_tokens: { type: "integer", minimum: 1 },
                query_instruction: { type: "string" },
              },
            },
          },
        },
      },
    },
    routes: {
      type: "array",
      items: {
        type: "object",
        required: ["match", "prefer"],
        additionalProperties: false,
        properties: { match: { type: "string" }, prefer: { type: "array", items: { type: "string" } } },
      },
    },
    budgets: {
      type: "array",
      items: {
        type: "object",
        required: ["match"],
        additionalProperties: false,
        properties: {
          match: { type: "string" },
          period: { enum: ["day", "month", "total"] },
          limit: { type: "number", minimum: 0 },
          pooled: { type: "boolean" },
        },
      },
    },
    cache: {
      type: "object",
      additionalProperties: false,
      properties: {
        backend: { enum: ["none", "memory", "valkey"] },
        ttl_s: { type: "integer", minimum: 1 },
        max_entries: { type: "integer", minimum: 1 },
        operations: { type: "array", items: { enum: ["complete", "embed", "rerank"] }, uniqueItems: true },
      },
    },
  },
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Input<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? Input<U>[] : T[K] extends object ? Input<T[K]> : T[K] };

/** A validated config with every default filled in. */
export function parseGatewayConfig(value: unknown): GatewayConfig {
  const errors = schemaErrors(SCHEMA, value);
  if (errors.length) throw new ConfigError(`invalid gateway config: ${errors.join("; ")}`);
  const raw = value as Input<GatewayConfig>;
  const config: GatewayConfig = {
    currency: raw.currency ?? "CNY",
    providers: (raw.providers ?? []).map((p) => ({
      ...(p as ProviderConfig),
      timeout_s: p.timeout_s ?? 60,
      max_retries: p.max_retries ?? 2,
      options: p.options ?? {},
      models: (p.models ?? []).map((m) => ({
        ...(m as ModelConfig),
        tiers: m.tiers ?? [],
        price: { input: 0, output: 0, ...m.price },
        json_schema: m.json_schema ?? false,
      })),
    })),
    routes: (raw.routes ?? []) as RouteConfig[],
    budgets: (raw.budgets ?? []).map((b) => ({ ...(b as BudgetConfig), period: b.period ?? "month" })),
    cache: { backend: "memory", ttl_s: 7 * 24 * 3600, max_entries: 10_000, operations: ["complete"], ...raw.cache },
  };
  const names = config.providers.map((p) => p.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new ConfigError(`invalid gateway config: provider ${duplicate} is defined twice`);
  const refs = new Set(config.providers.flatMap((p) => p.models.map((m) => `${p.name}/${m.name}`)));
  for (const route of config.routes) {
    const unknown = route.prefer.find((r) => !refs.has(r));
    if (unknown) throw new ConfigError(`invalid gateway config: route ${route.match} prefers unknown model ${unknown}`);
  }
  return config;
}

export function loadGatewayConfig(path: string): GatewayConfig {
  return parseGatewayConfig(parse(readFileSync(path, "utf8")));
}

/**
 * The same gateway with every provider replaced by the fake one answering with the
 * model_mocks stand-ins: models, prices, clearances, routes and budgets stay, so a dry run
 * meters what a real run would send and prices it, without a model server or a key. Its
 * prefix cache reports what a provider's would serve. The response cache stays in memory,
 * so stand-in replies never reach a cache that real runs share.
 */
export function standIn(config: GatewayConfig): GatewayConfig {
  return {
    ...config,
    providers: config.providers.map((p) => ({
      ...p,
      kind: "fake",
      options: { ...p.options, mocks: true, prefix_cache: true },
    })),
    cache: { ...config.cache, backend: config.cache.backend === "none" ? "none" : "memory" },
  };
}

/** Cost of one call in the gateway currency. Cached input tokens are a subset of input tokens. */
export function cost(price: Price, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const cachedPrice = price.cached_input ?? price.input;
  const uncached = Math.max(inputTokens - cachedTokens, 0);
  return (uncached * price.input + cachedTokens * cachedPrice + outputTokens * price.output) / 1_000_000;
}

/** Shell-style glob: * any run of characters, ? one character, [abc] one of a set. Case-sensitive. */
export function globMatch(pattern: string, text: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "[" && pattern.indexOf("]", i + 2) > i) {
      const end = pattern.indexOf("]", i + 2);
      const body = pattern.slice(i + 1, end);
      re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\/\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(text);
}

/** The first budget whose glob matches the key. */
export function budgetFor(config: GatewayConfig, budgetKey: string): BudgetConfig | undefined {
  return config.budgets.find((b) => globMatch(b.match, budgetKey));
}

/** Models to try first for a task, from the first matching route. */
export function preferredModels(config: GatewayConfig, task: string | undefined): string[] {
  if (task === undefined) return [];
  return config.routes.find((r) => globMatch(r.match, task))?.prefer ?? [];
}
