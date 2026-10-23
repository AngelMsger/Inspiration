/**
 * Slots: how claims about one single-valued fact line up across documents. Extraction fills
 * them, governance compares the values in them.
 */

import type { Claim } from "./generated.ts";

/**
 * A claim's slot: its predicate and its qualifiers, sorted ("hotel_cap_per_night|一线城市").
 * Undefined without a predicate. Subjects are not resolved yet, so they are not part of it.
 */
export function slotOf(claim: Pick<Claim, "predicate" | "qualifiers">): string | undefined {
  if (!claim.predicate) return undefined;
  return [claim.predicate, ...[...(claim.qualifiers ?? [])].sort()].join("|");
}

/** What two claims of a slot compare: the normalized value, else its number or text. */
export function valueKeyOf(claim: Pick<Claim, "value">): string | undefined {
  const v = claim.value;
  if (!v) return undefined;
  return v.normalized ?? (v.number !== undefined ? String(v.number) : v.text);
}
