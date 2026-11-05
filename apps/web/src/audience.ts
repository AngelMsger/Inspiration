// A space's readers as the page changes them: its audience without the space owners, which is
// what PUT audience takes, with one viewer added or taken out.

import type { PutSpaceOwners, SpaceAudience, SpaceGrant } from "@inspiration/contracts";

/** The grant that lets everyone in the company read a space. */
export const EVERYONE = "tenant";

/** The audience as PUT audience takes it: without the space owners. */
export const readersOf = (audience: SpaceAudience): SpaceGrant[] => audience.grants.filter((g) => g.role !== "owner");

/** The readers once `principal` is added as a viewer, or taken out. */
export function withReader(readers: SpaceGrant[], principal: string, add: boolean): SpaceGrant[] {
  const others = readers.filter((g) => g.principal_id !== principal);
  return add ? [...others, { principal_id: principal, role: "viewer" }] : others;
}

/** The space owners as the contract takes them, or nothing when none is picked. */
export function ownersOf(owners: string[]): PutSpaceOwners["owner_ids"] | undefined {
  const [first, ...rest] = owners;
  return first ? [first, ...rest] : undefined;
}
