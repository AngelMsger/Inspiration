/** Errors that cross component boundaries. */

import type { GatewayError, GatewayErrorCode, TokenUsage } from "./generated.ts";

const RETRYABLE: ReadonlySet<GatewayErrorCode> = new Set(["provider_error", "timeout"]);

/**
 * Thrown by every ModelGateway call that fails, in process or over HTTP. Carries the
 * contract GatewayError, so callers branch on `error.code` whichever gateway they use.
 */
export class GatewayException extends Error {
  readonly error: GatewayError;
  /** Tokens already spent when the call failed (an invalid structured output is still charged). */
  usage: TokenUsage | undefined;

  constructor(code: GatewayErrorCode, message: string, options: { requestId?: string; cause?: unknown } = {}) {
    super(`${code}: ${message}`, { cause: options.cause });
    this.name = "GatewayException";
    this.error = { code, message, retryable: RETRYABLE.has(code) };
    if (options.requestId !== undefined) this.error.request_id = options.requestId;
  }

  get code(): GatewayErrorCode {
    return this.error.code;
  }
}

/** A value that does not match its contract schema. */
export class ContractError extends TypeError {
  readonly errors: readonly string[];

  constructor(typeName: string, errors: readonly string[]) {
    super(`invalid ${typeName}: ${errors.join("; ")}`);
    this.name = "ContractError";
    this.errors = errors;
  }
}
