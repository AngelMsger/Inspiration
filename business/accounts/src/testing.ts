/** Test doubles for packages that sign people in through accounts: @inspiration/accounts/testing. */

import { createHash } from "node:crypto";
import type { IdentityProvider, ProviderIdentity, SignInRequest } from "./oidc.ts";

/** An identity provider that signs in whoever the test names for the next code, checking PKCE and the nonce. */
export class FakeProvider implements IdentityProvider {
  readonly name = "fake";
  readonly requests: SignInRequest[] = [];
  readonly codes = new Map<string, { who: ProviderIdentity; challenge: string; nonce: string }>();

  async signInUrl(request: SignInRequest): Promise<string> {
    this.requests.push(request);
    return `https://idp.example/authorize?state=${request.state}`;
  }

  /** The code the provider would send back for the last sign-in, signing in `who`. */
  code(who: ProviderIdentity): { code: string; state: string } {
    const request = this.requests.at(-1) as SignInRequest;
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, { who, challenge: request.challenge, nonce: request.nonce });
    return { code, state: request.state };
  }

  async finish(code: string, verifier: string, nonce: string): Promise<ProviderIdentity> {
    const issued = this.codes.get(code);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!issued || issued.challenge !== challenge || issued.nonce !== nonce) throw new Error("bad code");
    this.codes.delete(code);
    return issued.who;
  }

  async signOutUrl(): Promise<string> {
    return "https://idp.example/end";
  }
}
