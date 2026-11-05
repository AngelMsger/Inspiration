/**
 * Tenancy: companies (tenants) and their members, the one rule that assigns member IDs, the
 * product roles and invite links. The business layer is the system of record; the engine
 * keeps a copy of every company and member, which tenancy provisions through EngineDirectory
 * after each change, and in full on resync().
 *
 *     const tenancy = new Tenancy(new PostgresTenancy(pool), engineDirectory);
 *     const { company, member } = await tenancy.create(person, { name, default_locale: "zh-CN" });
 *     const { code } = await tenancy.invite(member);        // the link <site>/join/<code>
 *     await tenancy.join(colleague, code);                  // joins as a member
 *
 * - A person is an account (usr_, never sent to the engine) with a member (mem_) in each
 *   company they join. assignMemberId is the only place one is made from the other.
 * - Two product roles: the super admin runs the company (members, invite links, spaces through
 *   the engine) and a member works in it. Owners are named on spaces, in the engine. A
 *   company always keeps an active super admin: a change that would take the last one away
 *   raises TenancyError "conflict". engineRoles gives the engine's internal roles for each.
 * - An invite link joins anyone who opens it signed in, for INVITE_DAYS days, unless a super
 *   admin revokes it or its maker stops being a super admin. Only the hash of its code is
 *   kept. Joining twice keeps the membership as it is; someone who left comes back as a
 *   member with the member ID they had.
 * - Removing a member marks them left; the engine then drops every grant they hold.
 * - A site may offer a sample company (the sample option): visit() joins any account to it as
 *   a member. The engine keeps its record and documents, from a corpus, so tenancy sends only
 *   its visitors, never the company. It is not among an account's companies, and its
 *   members are not listed.
 * - Requests the actor may not make raise TenancyError "forbidden"; unknown members, invites
 *   and codes raise RangeError, which callers answer as not found.
 *
 * Planned are joining by verified email domain, transfers from the personal library, and
 * offboarding with handovers.
 */

export * from "./migrations.ts";
export * from "./postgres.ts";
export * from "./store.ts";
export * from "./tenancy.ts";
