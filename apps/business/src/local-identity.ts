/** A single workstation owner. Explicit local mode only, with the ordinary browser-bound sign-in flow. */
import { createHash, randomBytes } from "node:crypto";
import { type IdentityProvider, type ProviderIdentity, SignInError, type SignInRequest } from "@inspiration/accounts";

export class LocalIdentity implements IdentityProvider {
  readonly name = "local";
  readonly #origin: string;
  readonly #codes = new Map<string, { request: SignInRequest; expires: number }>();

  constructor(publicUrl: string) {
    const url = new URL(publicUrl);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new RangeError("local mode needs an http://localhost public URL");
    }
    this.#origin = url.origin;
  }

  async signInUrl(request: SignInRequest): Promise<string> {
    for (const [key, value] of this.#codes) if (value.expires < Date.now()) this.#codes.delete(key);
    const code = randomBytes(32).toString("base64url");
    this.#codes.set(code, { request, expires: Date.now() + 60_000 });
    return `${this.#origin}/api/auth/callback?${new URLSearchParams({ code, state: request.state })}`;
  }

  async finish(code: string, verifier: string, nonce: string): Promise<ProviderIdentity> {
    const entry = this.#codes.get(code);
    this.#codes.delete(code);
    if (
      !entry ||
      entry.expires < Date.now() ||
      entry.request.nonce !== nonce ||
      entry.request.challenge !== createHash("sha256").update(verifier).digest("base64url")
    ) {
      throw new SignInError("local sign-in expired; open the local app again");
    }
    return { subject: "workstation-owner", email: "owner@localhost", email_verified: true, name: "Local owner" };
  }

  async signOutUrl(): Promise<string> {
    return `${this.#origin}/`;
  }
}
