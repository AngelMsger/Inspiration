/**
 * Access control: permissions for members and agents, on SpiceDB. Members, services, groups
 * and departments are keyed by tenant, since their IDs are unique only within it. Visibility
 * comes from spaces: a source's documents, and what is derived from them, are readable by
 * whoever may read the source's space. Source ACLs decide nothing.
 *
 *     const service = new AuthzService(new SpiceDBGraph(connect(endpoint, key)), store); // or new MemoryGraph()
 *     await service.createSpace(spaceId, { tenantId, ownerId });
 *     await service.grantSpace(spaceId, "viewer", tenantId);         // everyone in the tenant reads it
 *     await service.registerSource(sourceId, spaceId);
 *     const filter = await service.scopeFilter(principal, "read");   // pushed into search indexes
 *
 * Apply the schema with `pnpm --filter @inspiration/access-control exec inspiration-authz-schema`.
 *
 * Principal tokens (tokens.ts) say who a request acts for: a JWT the business layer signs with
 * Ed25519, verified against its published keys. `@inspiration/access-control/testing` has a
 * development issuer for tests and local runs.
 *
 *     const tokens = new TokenVerifier({ issuer, audience, keys: jwksFromUrl(jwksUrl) });
 *     const who = await tokens.verify(bearer);                       // or a TokenError
 */

export {
  formatRelationship,
  type Graph,
  GraphError,
  type ObjectRef,
  obj,
  type Relationship,
  rel,
  type SubjectRef,
  schemaText,
  sortRelationships,
  subject,
} from "./graph.ts";
export { MemoryGraph, parseSchema } from "./memory-graph.ts";
export {
  AuthzService,
  chunkTokens,
  documentRef,
  LINEAGE_DEPTH,
  PrincipalError,
  principalObjectId,
  SPACE_ROLES,
  type SpaceResolver,
  subjectOf,
  supportingVersions,
} from "./service.ts";
export { BULK_CHUNK, closeClient, connect, type SpiceDBClient, SpiceDBGraph, writeSchema } from "./spicedb.ts";
export {
  type Jwks,
  jwksFromUrl,
  type KeySource,
  type PublicJwk,
  staticKeys,
  TokenError,
  TokenVerifier,
} from "./tokens.ts";
