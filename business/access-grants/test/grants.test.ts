import { describe, expect } from "vitest";
import { SECRET_PREFIX } from "../src/index.ts";
import { BACKENDS, grantsTest, LI, ZHANG, ZHOU } from "./fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;
const FINANCE = "spc_01HENGYUAN000000000FINANCE";

describe.each(BACKENDS)("access grants on $backend", ({ backend, skip }) => {
  const it = grantsTest(backend);

  it.skipIf(skip)("makes a token whose secret is shown once and kept only as a hash", async ({ setup }) => {
    const { grants } = setup;
    const { grant, secret } = await grants.create(ZHANG, { name: "Claude", spaces: [FINANCE], days: 30 });
    expect(secret.startsWith(SECRET_PREFIX)).toBe(true);
    expect(JSON.stringify(grant)).not.toContain(secret.slice(SECRET_PREFIX.length));
    expect(grant).toMatchObject({
      id: expect.stringMatching(/^tok_/),
      member_id: ZHANG.id,
      spaces: [FINANCE],
      scopes: ["knowledge.read"],
      created_at: "2026-11-05T07:00:00.000Z",
      expires_at: "2026-12-05T07:00:00.000Z",
    });
    expect(await grants.check(secret)).toMatchObject({ id: grant.id, spaces: [FINANCE] });
    expect(await grants.check(`${secret}x`)).toBeUndefined();
    expect(await grants.check("not a token")).toBeUndefined();
    await expect(grants.create(ZHANG, { name: "Long", spaces: "all", days: 91 })).rejects.toThrow(RangeError);
  });

  it.skipIf(skip)("keeps the last use to the minute, and stops at expiry", async ({ setup }) => {
    const { grants, clock } = setup;
    const { secret } = await grants.create(ZHANG, { name: "Script", spaces: "all", days: 1 });
    clock.advance(90 * 1000);
    expect((await grants.check(secret))?.last_used_at).toBe("2026-11-05T07:01:00.000Z");
    expect((await grants.list(ZHANG))[0]?.last_used_at).toBe("2026-11-05T07:01:00.000Z");
    clock.advance(DAY);
    expect(await grants.check(secret)).toBeUndefined();
    expect(await grants.list(ZHANG)).toEqual([]);
  });

  it.skipIf(skip)("lists a member's own tokens, and every member's for a super admin", async ({ setup }) => {
    const { grants, clock } = setup;
    await grants.create(ZHANG, { name: "First", spaces: "all", days: 30 });
    clock.advance(1000);
    await grants.create(ZHANG, { name: "Second", spaces: "all", days: 30 });
    await grants.create(LI, { name: "Li's", spaces: "all", days: 30 });
    expect((await grants.list(ZHANG)).map((g) => g.name)).toEqual(["Second", "First"]);
    expect((await grants.list(ZHOU, { all: true })).map((g) => g.name).sort()).toEqual(["First", "Li's", "Second"]);
    expect(await grants.list(ZHOU)).toEqual([]);
  });

  it.skipIf(skip)("revokes at once: one's own, or anyone's for a super admin", async ({ setup }) => {
    const { grants } = setup;
    const zhangs = await grants.create(ZHANG, { name: "Zhang's", spaces: "all", days: 30 });
    const lis = await grants.create(LI, { name: "Li's", spaces: "all", days: 30 });
    await expect(grants.revoke(LI, zhangs.grant.id)).rejects.toThrow(RangeError);
    await grants.revoke(ZHANG, zhangs.grant.id);
    expect(await grants.check(zhangs.secret)).toBeUndefined();
    await expect(grants.revoke(ZHANG, zhangs.grant.id)).rejects.toThrow(RangeError);
    await grants.revoke(ZHOU, lis.grant.id);
    expect(await grants.check(lis.secret)).toBeUndefined();
    await expect(grants.revoke(ZHOU, "tok_01UNKNOWN0000")).rejects.toThrow(RangeError);
  });

  it.skipIf(skip)("ends every token of a member who leaves", async ({ setup }) => {
    const { grants } = setup;
    const first = await grants.create(ZHANG, { name: "First", spaces: "all", days: 30 });
    const second = await grants.create(ZHANG, { name: "Second", spaces: [FINANCE], days: 30 });
    const lis = await grants.create(LI, { name: "Li's", spaces: "all", days: 30 });
    await grants.revokeAll(ZHANG.tenant_id, ZHANG.id);
    expect(await grants.check(first.secret)).toBeUndefined();
    expect(await grants.check(second.secret)).toBeUndefined();
    expect(await grants.check(lis.secret)).toBeDefined();
  });
});
