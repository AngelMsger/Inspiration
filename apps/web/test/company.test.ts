// A demo company as its super admins change it: roles, members who leave, invite links and joining
// by one, with the rules the business backend keeps. Every answer is held to its contract type.

import { contractErrors } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { Company, Refused } from "../src/company.ts";
import type { People } from "../src/people.ts";

const ADMIN = { member: "mem_01ADMIN0000", name: "Zhao Lin", email: "zhao@example.com", role: "super_admin" as const };
const MEMBER = { member: "mem_01MEMBER000", name: "Wang Fang", email: "wang@example.com" };
const SCRIPTED = { member: "mem_01SCRIPTED0", name: "Li Na", email: "li@example.com" };
const people: People = { tenant: "ten_01HENGYUAN", people: [ADMIN, MEMBER, SCRIPTED] };

const site = (code: string) => `https://demo.example/join/${code}`;
const NOW = new Date("2026-11-05T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** What a call refused with, as its status and code. */
function refusal(call: () => unknown): [number, string] | undefined {
  try {
    call();
  } catch (e) {
    if (e instanceof Refused) return [e.status, e.code];
    throw e;
  }
  return undefined;
}

describe("a demo company", () => {
  test("lists its members as the contract does, with the roles people.yaml gives", () => {
    const company = new Company(people);
    const list = { members: company.members() };
    expect(contractErrors("MemberList", list)).toEqual([]);
    expect(list.members.map((m) => m.role)).toEqual(["super_admin", "member", "member"]);
  });

  test("lets only a super admin change roles, and keeps a super admin", () => {
    const company = new Company(people);
    expect(refusal(() => company.setRole(MEMBER, SCRIPTED.member, "super_admin"))).toEqual([403, "forbidden"]);
    expect(refusal(() => company.setRole(ADMIN, ADMIN.member, "member"))).toEqual([409, "conflict"]);
    const promoted = company.setRole(ADMIN, MEMBER.member, "super_admin");
    expect(contractErrors("CompanyMember", promoted)).toEqual([]);
    // With a second super admin, the first may step down; then they can no longer change roles.
    company.setRole(MEMBER, ADMIN.member, "member");
    expect(company.roleOf(ADMIN)).toBe("member");
    expect(refusal(() => company.setRole(ADMIN, SCRIPTED.member, "super_admin"))).toEqual([403, "forbidden"]);
    expect(() => company.setRole(MEMBER, "mem_01NOBODY000", "member")).toThrow(RangeError);
  });

  test("removes a member, who then has an account but no company, and keeps the demo's script whole", () => {
    const company = new Company(people, [SCRIPTED.member]);
    expect(refusal(() => company.remove(ADMIN, SCRIPTED.member))).toEqual([409, "demo_script"]);
    expect(refusal(() => company.remove(ADMIN, ADMIN.member))).toEqual([409, "conflict"]);
    company.remove(ADMIN, MEMBER.member);
    expect(company.members().map((m) => m.member_id)).toEqual([ADMIN.member, SCRIPTED.member]);
    const outside = company.sessionOf(MEMBER, "Hengyuan");
    expect(contractErrors("Session", outside)).toEqual([]);
    expect([outside.companies, outside.current]).toEqual([[], undefined]);
    expect(() => company.remove(ADMIN, MEMBER.member)).toThrow(RangeError);
  });

  test("makes invite links a super admin sees until they expire or are revoked", () => {
    const company = new Company(people);
    expect(refusal(() => company.invite(MEMBER, site))).toEqual([403, "forbidden"]);
    const first = company.invite(ADMIN, site, NOW);
    const second = company.invite(ADMIN, site, new Date(NOW.getTime() + DAY));
    expect(contractErrors("InviteLink", first)).toEqual([]);
    expect(first.url).toMatch(/^https:\/\/demo\.example\/join\/[0-9a-f]{32}$/);
    expect(new Date(first.invite.expires_at).getTime() - NOW.getTime()).toBe(7 * DAY);
    const open = company.invites(ADMIN, NOW);
    expect(contractErrors("InviteList", open)).toEqual([]);
    expect(open.invites.map((i) => i.id)).toEqual([second.invite.id, first.invite.id]);
    company.revoke(ADMIN, first.invite.id);
    expect(() => company.revoke(ADMIN, first.invite.id)).toThrow(RangeError);
    expect(company.invites(ADMIN, NOW).invites.map((i) => i.id)).toEqual([second.invite.id]);
    // A week and a day later, the second has expired too.
    expect(company.invites(ADMIN, new Date(NOW.getTime() + 8 * DAY)).invites).toEqual([]);
  });

  test("shows anyone holding a link what it joins; unknown, expired and revoked codes alike are not found", () => {
    const company = new Company(people);
    const link = company.invite(ADMIN, site, NOW);
    const code = link.url.split("/").pop() as string;
    const preview = company.preview(code, "Hengyuan", NOW);
    expect(contractErrors("JoinPreview", preview)).toEqual([]);
    expect(preview).toEqual({
      company: { name: "Hengyuan" },
      invited_by: { display_name: ADMIN.name },
      expires_at: link.invite.expires_at,
    });
    expect(() => company.preview("0".repeat(32), "Hengyuan", NOW)).toThrow(RangeError);
    expect(() => company.preview(code, "Hengyuan", new Date(NOW.getTime() + 8 * DAY))).toThrow(RangeError);
    company.revoke(ADMIN, link.invite.id);
    expect(() => company.preview(code, "Hengyuan", NOW)).toThrow(RangeError);
  });

  test("closes a link once its maker is no longer a super admin", () => {
    const company = new Company(people);
    const link = company.invite(ADMIN, site, NOW);
    company.setRole(ADMIN, MEMBER.member, "super_admin");
    company.setRole(MEMBER, ADMIN.member, "member");
    expect(company.invites(MEMBER, NOW).invites).toEqual([]);
    expect(() => company.preview(link.url.split("/").pop() as string, "Hengyuan", NOW)).toThrow(RangeError);
  });

  test("joins someone who left by a link as a member, and keeps a member who joins again as they were", () => {
    const company = new Company(people);
    const link = company.invite(ADMIN, site, NOW);
    const code = link.url.split("/").pop() as string;
    // A super admin who leaves and comes back by a link is a member again.
    company.setRole(ADMIN, MEMBER.member, "super_admin");
    company.remove(ADMIN, MEMBER.member);
    company.join(MEMBER, code, NOW);
    company.join(ADMIN, code, NOW);
    expect(company.isMember(MEMBER)).toBe(true);
    expect([company.roleOf(MEMBER), company.roleOf(ADMIN)]).toEqual(["member", "super_admin"]);
    // Only the one who came back counts as joined through the link.
    expect(company.invites(ADMIN, NOW).invites[0]?.joined).toBe(1);
    expect(() => company.join(MEMBER, "0".repeat(32), NOW)).toThrow(RangeError);
  });
});
