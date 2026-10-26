/**
 * The relationship graph access control reasons over, with two backends: SpiceDB
 * (spicedb.ts) and an in-memory evaluator of the same schema.zed for component tests
 * (memory-graph.ts).
 */

import { readFileSync } from "node:fs";

export interface ObjectRef {
  readonly type: string;
  readonly id: string;
}

export interface SubjectRef {
  readonly type: string;
  /** "*" for a wildcard such as user:*. */
  readonly id: string;
  /** "member" for group#member. */
  readonly relation?: string;
}

export interface Relationship {
  readonly resource: ObjectRef;
  readonly relation: string;
  readonly subject: SubjectRef;
}

/** A write the schema does not allow (an unknown relation, a subject type the relation does not take). */
export class GraphError extends Error {
  override name = "GraphError";
}

export interface Graph {
  /** Consistency token of this process's last write, when there was one. */
  readonly token: string | undefined;
  /** Apply all updates atomically and return the consistency token of the write. */
  write(updates: { touch?: readonly Relationship[]; delete?: readonly Relationship[] }): Promise<string | undefined>;
  read(resourceType: string, resourceId?: string, relation?: string): Promise<Relationship[]>;
  check(resource: ObjectRef, permission: string, subject: SubjectRef): Promise<boolean>;
  checkMany(items: readonly (readonly [ObjectRef, string])[], subject: SubjectRef): Promise<boolean[]>;
  /** IDs of every resource of the type on which subject has the permission, sorted. */
  lookup(resourceType: string, permission: string, subject: SubjectRef): Promise<string[]>;
}

export const obj = (type: string, id: string): ObjectRef => ({ type, id });

export const subject = (type: string, id: string, relation?: string): SubjectRef =>
  relation ? { type, id, relation } : { type, id };

export const rel = (resource: ObjectRef, relation: string, subj: SubjectRef): Relationship => ({
  resource,
  relation,
  subject: subj,
});

/** SpiceDB's text form, "document:x#viewer@group:y#member". Also a key for sets and sorting. */
export function formatRelationship(r: Relationship): string {
  const s = r.subject;
  return `${r.resource.type}:${r.resource.id}#${r.relation}@${s.type}:${s.id}${s.relation ? `#${s.relation}` : ""}`;
}

export function sortRelationships(rels: Iterable<Relationship>): Relationship[] {
  return [...rels]
    .map((r) => [formatRelationship(r), r] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, r]) => r);
}

/** The permission schema access control owns. */
export function schemaText(): string {
  return readFileSync(new URL("../schema.zed", import.meta.url), "utf8");
}
