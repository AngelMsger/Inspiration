import type { CompletionRequest } from "@inspiration/contracts";
import { MemoryBlobStore } from "@inspiration/kernel";
import { FakeProvider, Gateway, type GatewayConfig, type GatewayOptions, parseGatewayConfig } from "../src/index.ts";

/** A cloud provider cleared for internal content and a local one cleared for secret. */
export function gatewayConfig(options: { includeLocal?: boolean } = {}): GatewayConfig {
  const providers: unknown[] = [
    {
      name: "cloud",
      kind: "fake",
      max_sensitivity: "internal",
      models: [
        { name: "cloud-flash", operations: ["complete"], tiers: ["flash", "standard"], price: { input: 1, output: 2 } },
        { name: "cloud-embed", operations: ["embed"], dimensions: 64 },
      ],
    },
  ];
  if (options.includeLocal !== false) {
    providers.push({
      name: "local",
      kind: "fake",
      max_sensitivity: "secret",
      models: [
        { name: "local-chat", operations: ["complete"], tiers: ["flash", "standard", "flagship"], json_schema: true },
        { name: "local-embed", operations: ["embed"], dimensions: 64 },
        { name: "local-rerank", operations: ["rerank"] },
        { name: "local-ocr", operations: ["ocr"] },
      ],
    });
  }
  return parseGatewayConfig({
    currency: "CNY",
    providers,
    routes: options.includeLocal === false ? [] : [{ match: "freshness.*", prefer: ["local/local-chat"] }],
    budgets: [{ match: "tenant:capped*", period: "month", limit: 0.00001 }, { match: "*" }],
  });
}

/** A gateway on fake providers; options.providers replaces some of them. */
export function makeGateway(options: GatewayOptions & { includeLocal?: boolean } = {}): Gateway {
  const config = gatewayConfig(options);
  const providers = Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p, options.blobs)]));
  return new Gateway(config, {
    blobs: new MemoryBlobStore(),
    ...options,
    providers: { ...providers, ...options.providers },
  });
}

export function completionRequest(content = "hello", overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: "extraction.extract_claims",
    prompt_version: "claims@1",
    messages: [{ role: "user", content }],
    sensitivity: "internal",
    budget_key: "tenant:ten_x/extraction",
    ...overrides,
  };
}

export const SCHEMA = {
  type: "object",
  required: ["claims"],
  properties: { claims: { type: "array", items: { type: "string" } } },
};
