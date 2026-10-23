/** Raised by provider plugins. retryable lets the gateway retry or fall back to the next model. */
export class ProviderError extends Error {
  override name = "ProviderError";
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable;
    this.status = options.status;
  }
}
