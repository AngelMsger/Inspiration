import type { ApiError } from "@inspiration/contracts";
import type { AccessTokenList, CreatedAccessToken, InviteLink, Session } from "@inspiration/contracts/business";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Backend, type Browser, PUBLIC_URL, SAMPLE, startBackend, ZHANG, ZHOU } from "./fixtures.ts";

let site: Backend;
let zhou: Browser;
beforeEach(async () => {
  site = await startBackend();
  zhou = await site.signIn(ZHOU);
  await zhou.call("POST", "/api/companies", { name: "Qinghe Tech" });
});
afterEach(() => site.close());

const FINANCE = "spc_01HENGYUAN000000000FINANCE";
const HR = "spc_01HENGYUAN000000HRPAYROLL";

const make = (b: Browser, body: object = {}) =>
  b.call<CreatedAccessToken>("POST", "/api/tokens", { name: "Claude", spaces: "all", days: 30, ...body });

/** Zhang, joined to Zhou's company through a link. */
async function zhang(): Promise<{ browser: Browser; memberId: string }> {
  const link = (await zhou.call<InviteLink>("POST", "/api/invites", {})).body;
  const browser = await site.signIn(ZHANG);
  const joined = await browser.call<Session>("POST", `/api/join/${link.url.split("/").at(-1)}`, {});
  return { browser, memberId: joined.body.current?.member_id ?? "" };
}

/** An MCP client's call, with the secret and nothing else. */
const mcpCall = (secret?: string) =>
  site.browser().call(
    "POST",
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      ...(secret && { authorization: `Bearer ${secret}` }),
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  );

test("makes, lists and revokes a member's tokens, the secret shown once", async () => {
  const created = await make(zhou);
  expect(created.status).toBe(201);
  expect(created.body.secret).toMatch(/^insp_pat_/);
  expect(created.body.token).toMatchObject({ name: "Claude", spaces: "all", scopes: ["knowledge.read"] });

  const list = await zhou.call<AccessTokenList>("GET", "/api/tokens");
  expect(list.body).toEqual({ tokens: [created.body.token], mcp_url: `${PUBLIC_URL}/mcp` });
  expect(JSON.stringify(list.body)).not.toContain(created.body.secret);

  expect((await zhou.call("DELETE", `/api/tokens/${created.body.token.id}`)).status).toBe(204);
  expect((await zhou.call<AccessTokenList>("GET", "/api/tokens")).body.tokens).toEqual([]);
  expect((await zhou.call("DELETE", `/api/tokens/${created.body.token.id}`)).status).toBe(404);
});

test("refuses a space the member cannot read, over 90 days, and the sample company", async () => {
  site.engine.spaces = [{ id: FINANCE }];
  expect((await make(zhou, { spaces: [FINANCE] })).status).toBe(201);
  const hidden = await zhou.call<ApiError>("POST", "/api/tokens", { name: "HR", spaces: [HR], days: 30 });
  expect([hidden.status, hidden.body.error.message]).toEqual([400, `the member cannot read ${HR}`]);
  expect((await make(zhou, { days: 91 })).status).toBe(400);
  expect((await make(zhou, { name: "  " })).status).toBe(400);

  await zhou.call("POST", "/api/session", { tenant_id: SAMPLE.id });
  expect((await make(zhou)).status).toBe(403);
});

test("shows every member's tokens to a super admin, who may revoke any of them", async () => {
  const { browser, memberId } = await zhang();
  const made = await make(browser);
  expect((await browser.call("GET", "/api/tokens?all=true")).status).toBe(403);
  expect((await zhou.call<AccessTokenList>("GET", "/api/tokens")).body.tokens).toEqual([]);
  const all = await zhou.call<AccessTokenList>("GET", "/api/tokens?all=true");
  expect(all.body.tokens).toEqual([{ ...made.body.token, member: { member_id: memberId, display_name: "Zhang" } }]);
  expect((await zhou.call("DELETE", `/api/tokens/${made.body.token.id}`)).status).toBe(204);
  expect((await mcpCall(made.body.secret)).status).toBe(401);
});

test("passes an MCP call on as an agent acting for the member, never with the secret", async () => {
  site.engine.spaces = [{ id: FINANCE }];
  const { browser, memberId } = await zhang();
  const { token, secret } = (await make(browser, { spaces: [FINANCE] })).body;
  const answer = await mcpCall(secret);
  expect(answer.status).toBe(200);

  const call = site.engine.calls.at(-1);
  expect(call?.path).toBe("/v0/mcp");
  expect(call?.claims).toMatchObject({
    sub: `agt_${token.id.slice("tok_".length)}`,
    kind: "agent",
    obo: memberId,
    scope: "knowledge.read",
    spaces: [FINANCE],
    grant: token.id,
  });
  expect(JSON.stringify(call?.headers)).not.toContain(secret);
  expect(call?.headers["mcp-protocol-version"]).toBe("2025-11-25");
  expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ method: "tools/list" });
  expect((await browser.call<AccessTokenList>("GET", "/api/tokens")).body.tokens[0]?.last_used_at).toBeDefined();
});

test("refuses an MCP call without a working token, or for a member who left (401)", async () => {
  const none = await mcpCall();
  expect([none.status, none.headers.get("www-authenticate")]).toEqual([401, 'Bearer realm="inspiration"']);
  expect((await mcpCall("insp_pat_unknown")).status).toBe(401);

  const { browser, memberId } = await zhang();
  const { secret } = (await make(browser)).body;
  expect((await mcpCall(secret)).status).toBe(200);
  await zhou.call("DELETE", `/api/members/${memberId}`);
  expect((await mcpCall(secret)).status).toBe(401);
  expect(site.engine.to("/v0/mcp")).toHaveLength(1);
});
