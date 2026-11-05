import { describe, expect, test } from "vitest";
import { assignMemberId, engineRoles, INVITE_DAYS } from "../src/index.ts";
import { BACKENDS, LI, tenancyTest, ZHANG, ZHOU } from "./fixtures.ts";

const refused = (code: string) => expect.objectContaining({ name: "TenancyError", code });

describe("the member ID rule", () => {
  test("reuses the user ID's body and refuses anything else", () => {
    expect(assignMemberId("usr_01JC00000000000000000000AB")).toBe("mem_01JC00000000000000000000AB");
    expect(() => assignMemberId("mem_01JC00000000000000000000AB")).toThrow(RangeError);
  });

  test("bundles the engine's internal roles", () => {
    expect(engineRoles("super_admin")).toEqual(["owner", "admin", "security_admin", "auditor"]);
    expect(engineRoles("member")).toEqual(["member"]);
  });
});

describe.each(BACKENDS)("tenancy on $backend", ({ backend, skip }) => {
  const it = tenancyTest(backend);

  it.skipIf(skip)("creates a company with its creator as super admin, in the engine too", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { company, member } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    expect(company).toMatchObject({ name: "Qinghe", default_locale: "zh-CN", version: 1 });
    expect(company.id).toMatch(/^ten_/);
    expect(member).toMatchObject({ id: assignMemberId(ZHOU.userId), role: "super_admin", status: "active" });
    expect(engine.calls.map(([kind, r]) => [kind, r.version])).toEqual([
      ["tenant", 1],
      ["member", 1],
    ]);
    expect(await tenancy.companiesOf(ZHOU.userId)).toEqual([{ company, member }]);
    expect(await tenancy.membership(company.id, ZHANG.userId)).toBeUndefined();
  });

  it.skipIf(skip)("lists companies by name, and the same member ID in each", async ({ setup }) => {
    const { tenancy } = setup;
    await tenancy.create(ZHOU, { name: "Northwind", default_locale: "en" });
    await tenancy.create(ZHOU, { name: "Acme", default_locale: "ja" });
    const companies = await tenancy.companiesOf(ZHOU.userId);
    expect(companies.map((c) => c.company.name)).toEqual(["Acme", "Northwind"]);
    expect(new Set(companies.map((c) => c.member.id)).size).toBe(1);
  });

  it.skipIf(skip)("joins through a link, once, and counts who joined", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { company, member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    const { invite, code } = await tenancy.invite(zhou);
    expect(invite.code_hash).not.toContain(code);
    expect(await tenancy.preview(code)).toMatchObject({ company: { name: "Qinghe" }, invitedBy: { id: zhou.id } });

    const joined = await tenancy.join(ZHANG, code);
    expect(joined.member).toMatchObject({ role: "member", status: "active", display_name: "Zhang" });
    expect(engine.member(joined.member.id)).toEqual(joined.member);
    const again = await tenancy.join(ZHANG, code);
    expect(again.member).toEqual(joined.member);
    await tenancy.join(LI, code);
    expect((await tenancy.invites(zhou)).map((i) => i.joined)).toEqual([2]);
    expect((await tenancy.members(zhou)).map((m) => m.display_name)).toEqual(["Li", "Zhang", "Zhou"]);
    expect((await tenancy.membership(company.id, ZHANG.userId))?.member.id).toBe(joined.member.id);
  });

  it.skipIf(skip)(
    "closes a link when it expires, is revoked, or its maker is no longer super admin",
    async ({ setup }) => {
      const { tenancy, clock } = setup;
      const { member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
      const expiring = await tenancy.invite(zhou);
      const revoked = await tenancy.invite(zhou);
      await tenancy.revoke(zhou, revoked.invite.id);
      await expect(tenancy.join(ZHANG, revoked.code)).rejects.toThrow(RangeError);
      expect(await tenancy.preview(revoked.code)).toBeUndefined();
      expect(await tenancy.preview("not-a-code")).toBeUndefined();

      clock.advance(INVITE_DAYS);
      await expect(tenancy.join(ZHANG, expiring.code)).rejects.toThrow(RangeError);
      expect(await tenancy.invites(zhou)).toEqual([]);

      const { member: zhang } = await tenancy.join(ZHANG, (await tenancy.invite(zhou)).code);
      await tenancy.setRole(zhou, zhang.id, "super_admin");
      const byZhang = await tenancy.invite(zhang);
      await tenancy.setRole(zhou, zhang.id, "member");
      await expect(tenancy.join(LI, byZhang.code)).rejects.toThrow(RangeError);
    },
  );

  it.skipIf(skip)("lets only a super admin run the company", async ({ setup }) => {
    const { tenancy } = setup;
    const { member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    const { member: zhang } = await tenancy.join(ZHANG, (await tenancy.invite(zhou)).code);
    await expect(tenancy.invite(zhang)).rejects.toEqual(refused("forbidden"));
    await expect(tenancy.invites(zhang)).rejects.toEqual(refused("forbidden"));
    await expect(tenancy.setRole(zhang, zhang.id, "super_admin")).rejects.toEqual(refused("forbidden"));
    await expect(tenancy.remove(zhang, zhou.id)).rejects.toEqual(refused("forbidden"));
    await expect(tenancy.setRole(zhou, "mem_01JC0000000000000000NOBODY", "member")).rejects.toThrow(RangeError);
    expect((await tenancy.members(zhang)).length).toBe(2);
  });

  it.skipIf(skip)("always keeps a super admin", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    await expect(tenancy.setRole(zhou, zhou.id, "member")).rejects.toEqual(refused("conflict"));
    await expect(tenancy.remove(zhou, zhou.id)).rejects.toEqual(refused("conflict"));

    const { member: zhang } = await tenancy.join(ZHANG, (await tenancy.invite(zhou)).code);
    const promoted = await tenancy.setRole(zhou, zhang.id, "super_admin");
    expect(promoted).toMatchObject({ role: "super_admin", version: 2 });
    expect(engine.member(zhang.id)).toEqual(promoted);

    // Two super admins each step down at once: one of them must stay.
    const results = await Promise.allSettled([
      tenancy.setRole(zhou, zhou.id, "member"),
      tenancy.setRole(promoted, promoted.id, "member"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const admins = (await tenancy.members(zhou).catch(() => tenancy.members(promoted))).filter(
      (m) => m.role === "super_admin",
    );
    expect(admins).toHaveLength(1);
  });

  it.skipIf(skip)("removes a member, who comes back with the same ID", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { company, member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    const link = await tenancy.invite(zhou);
    const { member: zhang } = await tenancy.join(ZHANG, link.code);
    await tenancy.remove(zhou, zhang.id);
    expect(engine.member(zhang.id)).toMatchObject({ status: "left", version: 2 });
    expect(await tenancy.membership(company.id, ZHANG.userId)).toBeUndefined();
    expect(await tenancy.companiesOf(ZHANG.userId)).toEqual([]);
    await expect(tenancy.members(zhang)).rejects.toEqual(refused("forbidden"));

    // Repeating a removal sends the record again, for an engine call that failed.
    const before = engine.calls.length;
    await tenancy.remove(zhou, zhang.id);
    expect(engine.calls.length).toBe(before + 1);

    const back = await tenancy.join(ZHANG, link.code);
    expect(back.member).toMatchObject({ id: zhang.id, status: "active", role: "member", version: 3 });
  });

  it.skipIf(skip)("copies a new name to every company, and resends everything on resync", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    await tenancy.create(ZHOU, { name: "Acme", default_locale: "en" });
    await tenancy.join(ZHANG, (await tenancy.invite(zhou)).code);
    await tenancy.rename({ ...ZHOU, name: "Zhou Min" });
    const companies = await tenancy.companiesOf(ZHOU.userId);
    expect(companies.map((c) => c.member.display_name)).toEqual(["Zhou Min", "Zhou Min"]);
    expect(engine.member(zhou.id)?.display_name).toBe("Zhou Min");

    engine.calls.length = 0;
    expect(await tenancy.resync()).toBe(5);
    expect(engine.calls.filter(([kind]) => kind === "tenant")).toHaveLength(2);
  });

  it.skipIf(skip)("keeps the change when the engine fails, and resync repairs it", async ({ setup }) => {
    const { tenancy, engine } = setup;
    const { member: zhou } = await tenancy.create(ZHOU, { name: "Qinghe", default_locale: "zh-CN" });
    const { member: zhang } = await tenancy.join(ZHANG, (await tenancy.invite(zhou)).code);
    engine.failing = true;
    await expect(tenancy.remove(zhou, zhang.id)).rejects.toThrow("did not answer");
    expect((await tenancy.members(zhou)).map((m) => m.id)).toEqual([zhou.id]);
    engine.failing = false;
    await tenancy.resync();
    expect(engine.member(zhang.id)?.status).toBe("left");
  });
});
