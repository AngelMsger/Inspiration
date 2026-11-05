// The errors routes answer with, each an ApiError body with its status.

import type { ApiErrorCode } from "@inspiration/contracts";

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
export const notFound = (what: string) => new HttpError(404, "not_found", `no ${what}`);

/** Run a write whose RangeError means the request named something it may not, a 400. */
export async function validated<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof RangeError) throw badRequest(error.message);
    throw error;
  }
}
