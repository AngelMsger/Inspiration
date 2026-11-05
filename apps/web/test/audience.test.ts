// A space's readers as the page changes them: owners stay out of what PUT audience takes, a
// reader is added once as a viewer, and a space keeps at least one space owner.

import { contractErrors } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { EVERYONE, ownersOf, readersOf, withReader } from "../src/audience.ts";

const audience = {
  space_id: "spc_01FINANCE000",
  grants: [
    { principal_id: "mem_01ZHOUMIN000", role: "owner" as const },
    { principal_id: EVERYONE, role: "viewer" as const },
    { principal_id: "mem_01LINA00000", role: "viewer" as const },
  ],
};

describe("a space's readers", () => {
  test("leave the space owners to PUT owners", () => {
    expect(contractErrors("SpaceAudience", audience)).toEqual([]);
    expect(readersOf(audience).map((g) => g.principal_id)).toEqual([EVERYONE, "mem_01LINA00000"]);
  });

  test("gain a viewer once, and lose one", () => {
    const readers = readersOf(audience);
    const added = withReader(withReader(readers, "mem_01WANGLEI00", true), "mem_01WANGLEI00", true);
    expect(contractErrors("PutSpaceAudience", { grants: added })).toEqual([]);
    expect(added.map((g) => [g.principal_id, g.role])).toEqual([
      [EVERYONE, "viewer"],
      ["mem_01LINA00000", "viewer"],
      ["mem_01WANGLEI00", "viewer"],
    ]);
    expect(withReader(readers, EVERYONE, false)).toEqual([{ principal_id: "mem_01LINA00000", role: "viewer" }]);
  });

  test("are never set without a space owner", () => {
    expect(ownersOf([])).toBeUndefined();
    expect(ownersOf(["mem_01ZHOUMIN000", "mem_01LINA00000"])).toEqual(["mem_01ZHOUMIN000", "mem_01LINA00000"]);
  });
});
