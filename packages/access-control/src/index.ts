/**
 * Access control: permissions for people and agents, on SpiceDB.
 *
 *     const service = new AuthzService(new SpiceDBGraph(connect(endpoint, key)), store); // or new MemoryGraph()
 *     await service.mirror(aclSnapshot, { spaceId });                // on acl.changed
 *     const filter = await service.scopeFilter(principal, "read");   // pushed into search indexes
 *
 * Apply the schema with `pnpm --filter @inspiration/access-control exec inspiration-authz-schema`.
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
export { aclChangedHandler } from "./handlers.ts";
export { MemoryGraph, parseSchema } from "./memory-graph.ts";
export {
  AuthzService,
  aclTokens,
  documentObjectId,
  documentRef,
  LINEAGE_DEPTH,
  PrincipalError,
  SPACE_ROLES,
  type SpaceResolver,
  type SpaceRole,
  subjectOf,
  supportingVersions,
} from "./service.ts";
export { BULK_CHUNK, closeClient, connect, type SpiceDBClient, SpiceDBGraph, writeSchema } from "./spicedb.ts";
