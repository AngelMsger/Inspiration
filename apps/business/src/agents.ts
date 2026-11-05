// Apps with access (docs in index.ts): a member's personal access tokens, and the MCP address
// where a client's calls arrive with one and go on to the engine as an agent acting for the member.

import type { GrantRecord } from "@inspiration/access-grants";
import type { SignedIn } from "@inspiration/accounts";
import { parseAs } from "@inspiration/contracts";
import type { AccessToken, AccessTokenList, CreatedAccessToken, NewAccessToken } from "@inspiration/contracts/business";
import type { Member, Membership } from "@inspiration/tenancy";
import { EngineError } from "./engine.ts";
import { HttpError, readBody, readJson, sendJson, sendRaw } from "./http.ts";
import type { BackendOptions, Call, Route } from "./routes.ts";

/** The largest MCP request passed on. */
const MCP_LIMIT = 1024 * 1024;

const tokenOf = (grant: GrantRecord, member?: Member): AccessToken => ({
  id: grant.id,
  name: grant.name,
  spaces: grant.spaces,
  scopes: grant.scopes,
  created_at: grant.created_at,
  expires_at: grant.expires_at,
  ...(grant.last_used_at && { last_used_at: grant.last_used_at }),
  ...(member && { member: { member_id: member.id, display_name: member.display_name } }),
});

/** The routes of Apps with access and the MCP address. */
export function agentRoutes(o: BackendOptions): Route[] {
  const mcpUrl = `${o.publicUrl.replace(/\/$/, "")}/mcp`;
  return [
    {
      method: "GET",
      path: /^\/api\/tokens$/,
      needs: "member",
      run: async ({ res, url, current }) => {
        const all = url.searchParams.get("all") === "true";
        if (all && current.member.role !== "super_admin") {
          throw new HttpError(403, "forbidden", "only a super admin sees every member's tokens");
        }
        const grants = await o.grants.list(current.member, { all });
        const members = all ? new Map((await o.tenancy.members(current.member)).map((m) => [m.id, m])) : undefined;
        const list: AccessTokenList = {
          tokens: grants.map((g) => tokenOf(g, members?.get(g.member_id))),
          mcp_url: mcpUrl,
        };
        sendJson(res, 200, list);
      },
    },
    {
      method: "POST",
      path: /^\/api\/tokens$/,
      needs: "member",
      run: async ({ req, res, signedIn, current }) => {
        const input = parseAs<NewAccessToken>("NewAccessToken", await readJson(req));
        if (current.company.sample) throw new HttpError(403, "forbidden", "nobody changes the sample company");
        const name = input.name.trim();
        if (!name) throw new HttpError(400, "bad_request", "the name is blank");
        if (input.spaces !== "all") await readable(o, signedIn, current, input.spaces);
        const { grant, secret } = await o.grants.create(current.member, { ...input, name });
        const created: CreatedAccessToken = { token: tokenOf(grant), secret };
        sendJson(res, 201, created);
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/tokens\/([^/]+)$/,
      needs: "member",
      run: async ({ res, params: [id], current }) => {
        await o.grants.revoke(current.member, id ?? "");
        sendJson(res, 204);
      },
    },
    { method: "*", path: /^\/mcp$/, needs: "anyone", run: (call) => mcp(o, call) },
  ];
}

/** Refuse spaces the member cannot read, as the engine lists them for the member. */
async function readable(o: BackendOptions, signedIn: SignedIn, current: Membership, spaces: string[]): Promise<void> {
  const token = o.tokens.member(current.member, signedIn.user.locale, signedIn.session.created_at, { readOnly: true });
  const answer = await o.engine.forward(
    "/v0/spaces",
    { method: "GET", headers: {} },
    { tenantId: current.company.id, token },
  );
  if (answer.status !== 200) throw new EngineError(`the engine answered ${answer.status} to GET /v0/spaces`);
  const list = JSON.parse(Buffer.from(answer.body).toString("utf8")) as { spaces: { id: string }[] };
  const known = new Set(list.spaces.map((s) => s.id));
  const unknown = spaces.filter((s) => !known.has(s));
  if (unknown.length) throw new HttpError(400, "bad_request", `the member cannot read ${unknown.join(", ")}`);
}

/**
 * An MCP call: its bearer secret must name a token that works and a member still active in
 * their company. It goes on to the engine's MCP endpoint as the agent, never with the secret.
 */
async function mcp(o: BackendOptions, { req, res }: Call): Promise<void> {
  const secret = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const grant = secret ? await o.grants.check(secret) : undefined;
  const holder = grant && (await o.tenancy.activeMember(grant.tenant_id, grant.member_id));
  if (!grant || !holder) {
    const error = { code: "unauthenticated", message: "the access token is unknown, expired or revoked" };
    sendJson(res, 401, { error }, { "www-authenticate": 'Bearer realm="inspiration"' });
    return;
  }
  const method = req.method ?? "POST";
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req, MCP_LIMIT));
  const answer = await o.engine.forward(
    "/v0/mcp",
    { method, headers: req.headers, ...(body && { body }) },
    { tenantId: grant.tenant_id, token: o.tokens.agent(grant) },
  );
  sendRaw(res, answer.status, answer.contentType, answer.body);
}
