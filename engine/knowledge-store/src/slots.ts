/**
 * Fact slots from their claims: what the store answers for slot(tenant, key). Counts and a
 * few representatives, so a slot stated a thousand times is still a short answer.
 */

import {
  type Claim,
  type ClaimEvidence,
  type FactSlot,
  type SlotVariant,
  type SlotVersion,
  valueKeyOf,
} from "@inspiration/contracts";

/** Representatives a variant lists. */
export const REPRESENTATIVES = 5;

const CLOSED = new Set<Claim["status"]>(["superseded", "retracted"]);
const isCurrent = (c: Claim) => c.superseded_at === undefined && !CLOSED.has(c.status);
const earliest = (days: readonly (string | undefined)[]) =>
  days.filter((d): d is string => d !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
const byWeight = (a: Claim, b: Claim) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The slot of these claims, with the source versions their supporting evidence names. */
export function factSlot(
  tenantId: string,
  slotKey: string,
  claims: readonly Claim[],
  evidence: readonly ClaimEvidence[],
): FactSlot | undefined {
  const valued = claims.flatMap((c) => {
    const value = valueKeyOf(c);
    return value === undefined ? [] : [{ claim: c, value }];
  });
  if (!valued.length) return undefined;
  const versionsOf = new Map<string, string[]>();
  for (const e of evidence) {
    if (e.role !== "supports") continue;
    const ids = versionsOf.get(e.claim_id) ?? [];
    if (!ids.includes(e.source_version_id)) ids.push(e.source_version_id);
    versionsOf.set(e.claim_id, ids);
  }
  const groups = new Map<string, Claim[]>();
  for (const { claim, value } of valued) groups.set(value, [...(groups.get(value) ?? []), claim]);

  const variants: SlotVariant[] = [];
  const versions: SlotVersion[] = [];
  for (const [value, all] of groups) {
    const current = all.filter(isCurrent).sort(byWeight);
    const from = earliest(all.map((c) => c.valid_time.start));
    const knownTo = current.length ? undefined : latestOf(all.map((c) => c.superseded_at));
    versions.push({
      value,
      claim_count: all.length,
      known_from: earliest(all.map((c) => c.recorded_at)) as string,
      ...(knownTo && { known_to: knownTo }),
      ...(from && { valid_from: from }),
    });
    if (!current.length) continue;
    const sources = [...new Set(current.flatMap((c) => versionsOf.get(c.id) ?? []))];
    const representatives = current.slice(0, REPRESENTATIVES);
    const shown = [...new Set([...representatives.flatMap((c) => versionsOf.get(c.id) ?? []), ...sources])];
    const validFrom = earliest(current.map((c) => c.valid_time.start));
    variants.push({
      value,
      claim_count: current.length,
      source_version_count: sources.length,
      claim_ids: representatives.map((c) => c.id),
      source_version_ids: shown.slice(0, REPRESENTATIVES),
      ...(validFrom && { valid_from: validFrom }),
    });
  }
  variants.sort((a, b) => b.claim_count - a.claim_count || (a.value < b.value ? -1 : 1));
  versions.sort((a, b) => Date.parse(a.known_from) - Date.parse(b.known_from) || (a.value < b.value ? -1 : 1));
  const first = (valued.find(({ claim }) => isCurrent(claim)) ?? valued[0])?.claim as Claim;
  return {
    tenant_id: tenantId,
    slot_key: slotKey,
    ...(first.subject_entity_id && { subject_entity_id: first.subject_entity_id }),
    ...(first.predicate && { predicate: first.predicate }),
    ...(first.qualifiers?.length && { qualifiers: [...first.qualifiers].sort() }),
    variants,
    versions,
  };
}

function latestOf(days: readonly (string | undefined)[]): string | undefined {
  return days.filter((d): d is string => d !== undefined).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
