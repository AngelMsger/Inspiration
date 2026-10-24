/**
 * Slots: how claims about one single-valued fact line up across documents. Extraction fills
 * them, governance compares the values in them.
 */

import type { Claim } from "./generated.ts";

/**
 * A claim's slot key: the one it carries, else its subject entity when resolved, its
 * predicate and its qualifiers, sorted ("hotel_cap_per_night|一线城市",
 * "ent_…/hotel_cap_per_night|一线城市"). Undefined without a predicate. Subjects as written are
 * not part of it: the catalogue turns them into qualifiers (北京 is 一线城市).
 */
export function slotOf(
  claim: Pick<Claim, "slot_key" | "subject_entity_id" | "predicate" | "qualifiers">,
): string | undefined {
  if (claim.slot_key) return claim.slot_key;
  if (!claim.predicate) return undefined;
  const fact = [claim.predicate, ...[...(claim.qualifiers ?? [])].sort()].join("|");
  return claim.subject_entity_id ? `${claim.subject_entity_id}/${fact}` : fact;
}

/** What two claims of a slot compare: the normalized value, else its number or text. */
export function valueKeyOf(claim: Pick<Claim, "value">): string | undefined {
  const v = claim.value;
  if (!v) return undefined;
  return v.normalized ?? (v.number !== undefined ? String(v.number) : v.text);
}
