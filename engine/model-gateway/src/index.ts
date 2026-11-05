/**
 * The model gateway: routing by sensitivity, fallback, budgets, response cache, structured
 * output, metering, versioned prompts, and an HTTP service with a client.
 *
 *     const gateway = await Gateway.create(loadGatewayConfig(path), { usage: new PostgresUsage(pool), blobs });
 *     const completion = await gateway.complete({ task: "extraction.extract_claims", ... });
 *
 * Every call is metered in the usage ledger (UsageSink), failures included, with the member or
 * the space its request says it is charged to (member_id, space_id): the member who asked for
 * the work, or the space whose documents it reads. Budgets are sums over the ledger by budget
 * key; a member's own cap is not built yet.
 */

export * from "./cache.ts";
export * from "./config.ts";
export * from "./errors.ts";
export * from "./gateway.ts";
export * from "./http.ts";
export * from "./metering.ts";
export * from "./migrations.ts";
export * from "./prompts.ts";
export * from "./providers/anthropic.ts";
export type * from "./providers/base.ts";
export * from "./providers/fake.ts";
export * from "./providers/markdown.ts";
export * from "./providers/openai-compatible.ts";
export * from "./structured.ts";
