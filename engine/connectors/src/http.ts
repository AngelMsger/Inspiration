/** Bounded, validated JSON reads. Credentials never follow a redirect or appear in errors. */
import { schemaErrors } from "@inspiration/contracts";

export class ConnectionError extends Error {
  override name = "ConnectionError";
}

export async function remoteJson<T>(url: URL, init: RequestInit, schema: object, service: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    for (let attempt = 0; attempt < 2 && [429, 502, 503, 504].includes(response.status); attempt++) {
      const retry = Number(response.headers.get("retry-after"));
      // A longer server delay is reported to the user, not held as a hanging request.
      if (retry > 10) break;
      await response.body?.cancel();
      await new Promise((done) => setTimeout(done, (retry > 0 ? retry : attempt + 1) * 1000));
      response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    }
  } catch {
    throw new ConnectionError(
      `${service}: cannot connect. Check the server address, VPN, TLS certificate and network.`,
    );
  }
  if (!response.ok) {
    const help =
      response.status === 401
        ? "Check the credentials."
        : response.status === 403
          ? "Grant the connection access to these documents."
          : response.status === 429
            ? "Rate limited; retry later."
            : response.status === 404
              ? "Check the document or space ID and its access permissions."
              : "The server could not complete the request; retry later.";
    throw new ConnectionError(`${service}: HTTP ${response.status}. ${help}`);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (schemaErrors(schema, value).length) {
    throw new ConnectionError(
      `${service}: unexpected API response. Check the server address and supported API version.`,
    );
  }
  return value as T;
}

export function connectionUrl(base: string): URL {
  const url = new URL(`${base.replace(/\/+$/, "")}/`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RangeError("the connection needs an HTTP(S) base URL without credentials, query or fragment");
  }
  return url;
}
