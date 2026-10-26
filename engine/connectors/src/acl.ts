/** ACL snapshots as connectors report them: entries keyed by the source's own principal IDs. */

import {
  type AclEntry,
  type AclFidelity,
  type AclPrincipalKind,
  type AclRole,
  type AclSnapshot,
  canonicalJson,
  contentHash,
} from "@inspiration/contracts";

const ROLE_ORDER: Record<AclRole, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

/** Entries in a canonical order, one per principal with its highest role. */
export function normalizeEntries(entries: readonly AclEntry[]): AclEntry[] {
  const best = new Map<string, AclEntry>();
  for (const e of entries) {
    const key = `${e.principal_kind}\x1f${e.external_id ?? ""}`;
    const known = best.get(key);
    if (!known || ROLE_ORDER[e.role] > ROLE_ORDER[known.role]) best.set(key, { ...e });
  }
  return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
}

/** Hash of what the source says, so a sync can tell an ACL change from a content change. */
export function aclHash(entries: readonly AclEntry[], inheritsFrom?: string): string {
  return contentHash(canonicalJson([normalizeEntries(entries), inheritsFrom ?? null]));
}

export function aclSnapshot(
  sourceId: string,
  externalId: string,
  entries: readonly AclEntry[],
  options: { fidelity: AclFidelity; capturedAt: Date; inheritsFrom?: string },
): AclSnapshot {
  const normalized = normalizeEntries(entries);
  const snapshot: AclSnapshot = {
    source_id: sourceId,
    external_id: externalId,
    fidelity: options.fidelity,
    entries: normalized,
    captured_at: options.capturedAt.toISOString(),
    acl_hash: aclHash(normalized, options.inheritsFrom),
  };
  if (options.inheritsFrom !== undefined) snapshot.inherits_from_external_id = options.inheritsFrom;
  return snapshot;
}

const KINDS: Record<string, AclPrincipalKind> = {
  user: "user",
  group: "group",
  department: "department",
};

/**
 * One entry from the short form used in folder ACL files and fixtures: "user:li.na",
 * "group:finance", "department:sales", "tenant", "link" or "public".
 */
export function parseEntry(spec: string, role: AclRole): AclEntry {
  const [kind, ...rest] = spec.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "tenant":
      return { principal_kind: "anyone_in_tenant", role };
    case "link":
      return { principal_kind: "anyone_with_link", role };
    case "public":
      return { principal_kind: "public", role };
    default: {
      const principalKind = KINDS[kind ?? ""];
      if (!principalKind || !id) throw new RangeError(`bad ACL entry ${JSON.stringify(spec)}`);
      return { principal_kind: principalKind, external_id: id, role };
    }
  }
}
