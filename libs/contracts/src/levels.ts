/** Governance levels: how much of a source the engine governs (GovernanceLevel). */

import type { GovernanceLevel, SourceVersion } from "./generated.ts";

export const GOVERNANCE_LEVELS: readonly GovernanceLevel[] = ["governed", "reference", "search_only"];

export function isGovernanceLevel(value: unknown): value is GovernanceLevel {
  return GOVERNANCE_LEVELS.includes(value as GovernanceLevel);
}

/** A version's level. Versions written before levels have none and count as governed. */
export function levelOf(version: Pick<SourceVersion, "governance_level">): GovernanceLevel {
  return version.governance_level ?? "governed";
}
