import type { Session } from "@inspiration/contracts/business";
import { afterEach, beforeEach, expect, test } from "vitest";
import { COMPANY_HEADER } from "../src/index.ts";
import { type Backend, SAMPLE, startBackend, ZHANG, ZHOU } from "./fixtures.ts";

let site: Backend;
beforeEach(async () => {
  site = await startBackend();
});
afterEach(() => site.close());

const open = { tenant_id: SAMPLE.id };

test("opens the sample company to anyone signed in, as a member who only reads", async () => {
  const zhou = await site.signIn(ZHOU);
  const opened = await zhou.call<Session>("POST", "/api/session", open);
  expect(opened.status).toBe(200);
  expect(opened.body.companies).toEqual([]);
  expect(opened.body.current).toMatchObject({ tenant_id: SAMPLE.id, display_name: "Zhou", role: "member" });
  const member = opened.body.current?.member_id;
  expect(site.engine.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    `PUT /v0/tenants/${SAMPLE.id}/members/${member}`,
  ]);

  await zhou.call("GET", "/api/v0/spaces", undefined, { [COMPANY_HEADER]: SAMPLE.id });
  expect(site.engine.calls.at(-1)?.claims).toMatchObject({ sub: member, tid: SAMPLE.id, scope: "knowledge.read" });
  expect((await zhou.call("GET", "/api/members")).status).toBe(403);
  expect((await zhou.call("POST", "/api/invites", {})).status).toBe(403);

  // Opening it again sends the member again, as after the engine restarted.
  expect((await zhou.call<Session>("POST", "/api/session", open)).body.current?.member_id).toBe(member);
  expect(site.engine.to(`/v0/tenants/${SAMPLE.id}/members/`)).toHaveLength(2);
});

test("keeps the account's own companies first, with the sample beside them", async () => {
  const zhang = await site.signIn(ZHANG);
  await zhang.call("POST", "/api/session", open);
  const created = await zhang.call<Session>("POST", "/api/companies", { name: "Qinghe Tech" });
  expect(created.body.companies.map((c) => c.name)).toEqual(["Qinghe Tech"]);
  expect(created.body.sample).toEqual({ tenant_id: SAMPLE.id, name: SAMPLE.name });

  const again = await site.signIn(ZHANG);
  expect((await again.call<Session>("GET", "/api/session")).body.current?.tenant_id).toBe(
    created.body.current?.tenant_id,
  );
  expect(site.engine.to(`/v0/tenants/${SAMPLE.id}`).filter((c) => c.path === `/v0/tenants/${SAMPLE.id}`)).toEqual([]);
});
