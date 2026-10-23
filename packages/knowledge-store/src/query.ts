/**
 * ClaimQuery semantics, written once: as a predicate for the in-memory store and as SQL for
 * Postgres. Both must agree; the contract tests run against both.
 */

import type { Claim, ClaimQuery } from "@inspiration/contracts";

export interface AsOf {
  /** It was true in the world then. */
  validAt?: Date | undefined;
  /** The system believed it then. */
  knownAt: Date;
}

/** Number of claims an asOf read returns when the query sets no limit (the schema default). */
export const QUERY_LIMIT = 1000;

const after = (instant: string, t: Date) => Date.parse(instant) > t.getTime();

/** Everything except source_version_ids, which needs the evidence table. */
export function matches(claim: Claim, q: ClaimQuery, { validAt, knownAt }: AsOf): boolean {
  if (after(claim.recorded_at, knownAt)) return false;
  if (claim.superseded_at !== undefined && !after(claim.superseded_at, knownAt)) return false;
  if (validAt) {
    const { start, end } = claim.valid_time;
    if ((start !== undefined && after(start, validAt)) || (end !== undefined && !after(end, validAt))) return false;
  }
  const checks: [readonly string[] | undefined, string | undefined][] = [
    [q.ids, claim.id],
    [q.space_ids, claim.space_id],
    [q.subject_entity_ids, claim.subject_entity_id],
    [q.predicates, claim.predicate],
    [q.statuses, claim.status],
    [q.knowledge_classes, claim.knowledge_class],
  ];
  return checks.every(([wanted, value]) => !wanted?.length || (value !== undefined && wanted.includes(value)));
}

/** WHERE clause over kb.claims (alias c) and its parameters, numbered from $1. */
export function toSql(q: ClaimQuery, { validAt, knownAt }: AsOf): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const known = p(knownAt);
  const where = [`c.recorded_at <= ${known}`, `(c.superseded_at IS NULL OR c.superseded_at > ${known})`];
  if (validAt) {
    const valid = p(validAt);
    where.push(`(c.valid_from IS NULL OR c.valid_from <= ${valid}) AND (c.valid_to IS NULL OR c.valid_to > ${valid})`);
  }
  const filters: [string, readonly string[] | undefined][] = [
    ["c.id", q.ids],
    ["c.space_id", q.space_ids],
    ["c.subject_entity_id", q.subject_entity_ids],
    ["c.predicate", q.predicates],
    ["c.status", q.statuses],
    ["c.knowledge_class", q.knowledge_classes],
  ];
  for (const [column, values] of filters) {
    if (values?.length) where.push(`${column} = ANY(${p(values)}::text[])`);
  }
  if (q.source_version_ids?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM kb.claim_evidence e WHERE e.claim_id = c.id AND e.source_version_id = ANY(${p(q.source_version_ids)}::text[]))`,
    );
  }
  return { where: where.join(" AND "), params };
}
