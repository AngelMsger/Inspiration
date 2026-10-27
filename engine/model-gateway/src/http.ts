/**
 * HTTP service and client for the gateway, so components in other processes use the same
 * ModelGateway interface. Components depend on the interface; deployment decides whether
 * the gateway runs in process or behind HTTP.
 *
 * Routes: POST /v1/complete, /v1/embed, /v1/rerank, /v1/ocr; GET /v1/budgets/{key}; GET /healthz.
 * Errors return the contract GatewayError as JSON.
 */

import {
  type BudgetStatus,
  type Completion,
  type CompletionRequest,
  contractErrors,
  type EmbedRequest,
  type EmbedResult,
  type GatewayError,
  type GatewayErrorCode,
  GatewayException,
  type ModelGateway,
  type OcrRequest,
  type OcrResult,
  type RerankRequest,
  type RerankResult,
} from "@inspiration/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { budgetFor } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { budgetSpent, periodStart } from "./metering.ts";

export const ERROR_STATUS: Readonly<Record<GatewayErrorCode, ContentfulStatusCode>> = {
  budget_exceeded: 429,
  no_route: 422,
  bad_request: 400,
  invalid_output: 502,
  provider_error: 502,
  timeout: 504,
};

/** The gateway's HTTP app. Serve it with @hono/node-server, or call app.request in tests. */
export function createApp(gateway: Gateway): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof GatewayException) return c.json(err.error, ERROR_STATUS[err.code]);
    throw err;
  });

  app.get("/healthz", (c) => c.json({ ok: true, providers: gateway.config.providers.map((p) => p.name) }));

  const route = <Req>(path: string, typeName: string, handle: (req: Req) => Promise<unknown>) => {
    app.post(path, async (c: Context) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const errors = contractErrors(typeName, body);
      if (errors.length) return c.json({ code: "bad_request", message: errors.join("; "), retryable: false }, 422);
      return c.json(await handle(body as Req));
    });
  };
  route<CompletionRequest>("/v1/complete", "CompletionRequest", (r) => gateway.complete(r));
  route<EmbedRequest>("/v1/embed", "EmbedRequest", (r) => gateway.embed(r));
  route<RerankRequest>("/v1/rerank", "RerankRequest", (r) => gateway.rerank(r));
  route<OcrRequest>("/v1/ocr", "OcrRequest", (r) => gateway.ocr(r));

  app.get("/v1/budgets/:key{.+}", async (c) => {
    const budgetKey = decodeURIComponent(c.req.param("key"));
    const budget = budgetFor(gateway.config, budgetKey);
    const period = budget?.period ?? "total";
    const spent = await budgetSpent(
      gateway.usage,
      budget,
      budgetKey,
      periodStart(period, new Date(), gateway.timeZone),
    );
    const status: BudgetStatus = { budget_key: budgetKey, period, spent, currency: gateway.config.currency };
    if (budget?.limit !== undefined) status.limit = budget.limit;
    return c.json(status);
  });

  return app;
}

/** ModelGateway over HTTP. Throws GatewayException exactly like the in-process gateway. */
export class HttpModelGateway implements ModelGateway {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as T;
    let error: GatewayError | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!contractErrors("GatewayError", parsed).length) error = parsed as GatewayError;
    } catch {
      // not a GatewayError body
    }
    if (!error) throw new GatewayException("provider_error", `gateway HTTP ${response.status}: ${text.slice(0, 300)}`);
    throw new GatewayException(error.code, error.message, error.request_id ? { requestId: error.request_id } : {});
  }

  complete(req: CompletionRequest): Promise<Completion> {
    return this.#post("/v1/complete", req);
  }

  embed(req: EmbedRequest): Promise<EmbedResult> {
    return this.#post("/v1/embed", req);
  }

  rerank(req: RerankRequest): Promise<RerankResult> {
    return this.#post("/v1/rerank", req);
  }

  ocr(req: OcrRequest): Promise<OcrResult> {
    return this.#post("/v1/ocr", req);
  }
}
