// Principal tokens: the business backend signs one for every call it makes to the engine, as
// the member the browser acts for or as the tenancy service, and publishes the public half of
// its key as a JWKS (/.well-known/jwks.json) for the engine to verify them with.

import { randomUUID } from "node:crypto";
import type { GrantRecord } from "@inspiration/access-grants";
import type { PrincipalClaims, Scope } from "@inspiration/contracts";
import { type SigningKey, signJwt } from "@inspiration/kernel";
import type { Company, Member } from "@inspiration/tenancy";

/** How long a token lives: the engine allows at most 15 minutes, a web token gets 5. */
export const TOKEN_SECONDS = 5 * 60;

/** The tenancy service's principal in every tenant. */
export const TENANCY_SERVICE = "svc_01TENANCY0000000000000000";

/** What a member may do through the web app. Edits on a member's request (knowledge.write) are for agents, later. */
const MEMBER_SCOPES: readonly Scope[] = ["knowledge.read", "knowledge.propose"];
/** What a visitor may do in the sample company: read, so the engine refuses every change. */
const READER_SCOPES: readonly Scope[] = ["knowledge.read"];

export class Tokens {
  readonly issuer: string;
  readonly audience: string;
  readonly #key: SigningKey;
  readonly #now: () => Date;

  /** issuer is this backend's public URL; audience the engine's. */
  constructor(options: { issuer: string; audience: string; key: SigningKey; clock?: () => Date }) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.#key = options.key;
    this.#now = options.clock ?? (() => new Date());
  }

  /** The keys the engine verifies tokens with. */
  jwks(): { keys: SigningKey["jwk"][] } {
    return { keys: [this.#key.jwk] };
  }

  /**
   * A token for the member in their company, in the account's language. signedInAt is when the
   * session began; a read-only token, as in the sample company, only reads.
   */
  member(member: Member, locale: string, signedInAt: string, options: { readOnly?: boolean } = {}): string {
    return this.#sign({
      sub: member.id,
      tid: member.tenant_id,
      kind: "member",
      scope: (options.readOnly ? READER_SCOPES : MEMBER_SCOPES).join(" "),
      locale,
      auth: { method: "password", mfa: false, at: signedInAt },
    });
  }

  /**
   * A token for an MCP client calling with a personal access token: an agent acting for the
   * token's member, with the token's scopes and, when it names any, its spaces. The engine
   * gives it the member's rights narrowed to those.
   */
  agent(grant: Pick<GrantRecord, "id" | "tenant_id" | "member_id" | "spaces" | "scopes">): string {
    return this.#sign({
      sub: `agt_${grant.id.slice("tok_".length)}`,
      tid: grant.tenant_id,
      kind: "agent",
      scope: grant.scopes.join(" "),
      obo: grant.member_id,
      ...(grant.spaces !== "all" && { spaces: grant.spaces }),
      grant: grant.id,
    });
  }

  /** A token for the tenancy service, to provision a company and its members. */
  service(company: Pick<Company, "id">): string {
    return this.#sign({ sub: TENANCY_SERVICE, tid: company.id, kind: "service", scope: "provision.directory" });
  }

  #sign(
    claims: Pick<PrincipalClaims, "sub" | "tid" | "kind" | "scope" | "locale" | "auth" | "obo" | "spaces" | "grant">,
  ): string {
    const iat = Math.floor(this.#now().getTime() / 1000);
    const payload: PrincipalClaims = {
      iss: this.issuer,
      aud: this.audience,
      ...claims,
      iat,
      exp: iat + TOKEN_SECONDS,
      jti: randomUUID(),
    };
    return signJwt({ ...payload }, this.#key);
  }
}
