/**
 * Access grants: the personal access tokens a member makes under Apps with access, for an MCP
 * client or a script. The business backend checks a token's secret on every call and passes
 * the call on to the engine as an agent acting for the member (tokens.ts in apps/business),
 * so a secret never leaves the business layer.
 *
 *     const grants = new AccessGrants(new PostgresGrants(pool));
 *     const { grant, secret } = await grants.create(member, { name, spaces: "all", days: 30 });
 *     const working = await grants.check(secret);   // undefined once revoked or expired
 *
 * - A token acts for one member in one company, in all the spaces the member can read or in
 *   the ones it names, and only reads (knowledge.read). It never does more than its member:
 *   the engine intersects the two on every call.
 * - It lasts 1 to TOKEN_DAYS days. Its secret starts with SECRET_PREFIX and is shown once;
 *   only its SHA-256 hash is kept.
 * - A member revokes their own tokens, a super admin anyone's in the company; revoking takes
 *   effect on the next call. A token already revoked or expired is gone, so revoking it again
 *   raises RangeError. revokeAll() ends a member's tokens when they leave.
 * - A token's last use is kept to the minute.
 *
 * Planned are the OAuth authorization server for MCP clients (PKCE, client registration),
 * the device flow for the CLI, company agents, and revocations pushed to the engine.
 */

export * from "./grants.ts";
export * from "./migrations.ts";
export * from "./postgres.ts";
export * from "./store.ts";
