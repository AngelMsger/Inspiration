// Gate check: one person in two companies never reads or changes one company from the other
// (issue #135). Zhou runs Qinghe Tech and is a member of Lanting Trading under the same member
// ID, as the first member ID rule makes it, and works in both from two tabs of one browser,
// through the real business backend and engine (site.ts). Each company has a space its whole
// company reads, with a travel policy only it states.

import type { Browser } from "@inspiration/business/testing";
import type {
  Delegation,
  DocumentEntry,
  DocumentView,
  FileWritten,
  GroundedAnswer,
  Me,
  SearchResult,
  SpaceList,
  SpaceWritten,
} from "@inspiration/contracts";
import type {
  AccessTokenList,
  CreatedAccessToken,
  InviteLink,
  InviteList,
  Session,
} from "@inspiration/contracts/business";
import type { Member } from "@inspiration/tenancy";
import { describe, expect } from "vitest";
import { BACKENDS, type Site, siteTest } from "./site.ts";

const ZHOU = { subject: "idp-zhou", email: "zhou@example.com", email_verified: true, name: "Zhou" };
const ZHANG = { subject: "idp-zhang", email: "zhang@example.com", email_verified: true, name: "Zhang" };
const LI = { subject: "idp-li", email: "li@example.com", email_verified: true, name: "Li" };

interface Company {
  id: string;
  /** Its maker's member ID. */
  maker: string;
  space: string;
  document: DocumentEntry;
  /** A word of its policy that the other company's never says. */
  word: string;
}

/** The answer's body when it has the status expected; the test fails here otherwise. */
async function ok<T>(answer: Promise<{ status: number; body: T }>, status = 200): Promise<T> {
  const { status: got, body } = await answer;
  expect([got, body]).toEqual([status, expect.anything()]);
  return body;
}

/** The status of an answer and its error code, as a refusal is checked. */
async function refusal(answer: Promise<{ status: number; body: unknown }>): Promise<[number, string | undefined]> {
  const { status, body } = await answer;
  return [status, (body as { error?: { code: string } }).error?.code];
}

/** A company its maker runs, with a space everyone in it reads and a policy read to the end. */
async function companyOf(maker: Browser, name: string, word: string): Promise<Company> {
  const made = await ok(maker.call<Session>("POST", "/api/companies", { name, default_locale: "en" }), 201);
  const memberId = made.current?.member_id ?? "";
  const { space } = await ok(
    maker.call<SpaceWritten>(
      "POST",
      "/api/v0/spaces",
      { name: "Policies", owner_ids: [memberId] },
      { "idempotency-key": `${name}/policies` },
    ),
  );
  await ok(
    maker.call("PUT", `/api/v0/spaces/${space.id}/audience`, { grants: [{ principal_id: "tenant", role: "viewer" }] }),
  );
  const policy = `# Travel\n\n${word} staff book hotels of up to ${word.length * 100} yuan a night.\n`;
  const { document } = await ok(
    maker.call<FileWritten>("PUT", `/api/v0/spaces/${space.id}/files/travel.md`, new TextEncoder().encode(policy), {
      "content-type": "text/markdown",
    }),
  );
  return { id: made.current?.tenant_id ?? "", maker: memberId, space: space.id, document, word };
}

/**
 * Zhou makes Qinghe Tech, Zhang makes Lanting Trading and invites Zhou by a link, Zhou joins
 * and goes back to Qinghe, and the engine reads both policies to the end.
 */
async function world(site: Site) {
  const zhou = await site.signIn(ZHOU);
  const qinghe = await companyOf(zhou, "Qinghe Tech", "Qinghe");
  const zhang = await site.signIn(ZHANG);
  const lanting = await companyOf(zhang, "Lanting Trading", "Lanting");
  const link = await ok(zhang.call<InviteLink>("POST", "/api/invites", {}), 201);
  const joined = await ok(zhou.call<Session>("POST", `/api/join/${link.url.split("/").at(-1)}`, {}));
  await ok(zhou.call<Session>("POST", "/api/session", { tenant_id: qinghe.id }));
  await site.engine.settle();
  return { zhou, zhang, qinghe, lanting, zhouInLanting: joined.current?.member_id ?? "" };
}

const spacesOf = async (tab: Browser) =>
  (await ok(tab.call<SpaceList>("GET", "/api/v0/spaces"))).spaces.map((s) => s.id);
const search = (tab: Browser) => ok(tab.call<SearchResult>("POST", "/api/v0/search", { text: "hotels a night" }));
const versionOf = (c: Company) => `/api/v0/documents?version=${c.document.source_version_id}`;

/** The document versions an answer to the policy question cites, each once. */
async function citedIn(tab: Browser): Promise<string[]> {
  const answer = await ok(
    tab.call<GroundedAnswer>("POST", "/api/v0/answers", { question: "How much is a hotel night?" }),
  );
  return [...new Set(answer.citations.map((c) => c.source_version_id))];
}

/** What a company holds that a stray call could add to: its invite links, access tokens, spaces and documents. */
async function holdings(tab: Browser) {
  const tokens = await ok(tab.call<AccessTokenList>("GET", "/api/tokens"));
  const invites = await tab.call<InviteList>("GET", "/api/invites");
  const spaces = await spacesOf(tab);
  const documents = await Promise.all(
    spaces.map(async (id) => JSON.stringify((await tab.call("GET", `/api/v0/spaces/${id}/documents`)).body)),
  );
  // A member who is not its super admin may not list its links: then the refusal stands in.
  const links = invites.status === 200 ? invites.body.invites.length : invites.status;
  return { tokens: tokens.tokens.length, invites: links, spaces, documents };
}

/** An MCP client's tool call with a personal access token, through the backend's /mcp. */
async function mcp(site: Site, secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${site.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { structuredContent?: unknown; isError?: boolean } };
  return { status: res.status, result: body.result };
}

describe.each(BACKENDS)("$backend", ({ backend, skip }) => {
  const test = siteTest(backend);

  describe.skipIf(skip)("one person in two companies", () => {
    test("is the same member in both, with each company's role and nothing more", async ({ site }) => {
      const { zhou, qinghe, lanting, zhouInLanting } = await world(site);
      expect(zhouInLanting).toBe(qinghe.maker);
      const session = await ok(zhou.call<Session>("GET", "/api/session"));
      expect(session.companies.map((c) => [c.name, c.role])).toEqual([
        ["Lanting Trading", "member"],
        ["Qinghe Tech", "super_admin"],
      ]);

      const inQinghe = await ok(zhou.call<Me>("GET", "/api/v0/me"));
      expect([inQinghe.tenant_id, inQinghe.member_id, inQinghe.admin]).toEqual([qinghe.id, qinghe.maker, true]);
      expect(await spacesOf(zhou)).toEqual([qinghe.space]);
      expect(await citedIn(zhou)).toEqual([qinghe.document.source_version_id]);
      await ok(zhou.call<Delegation>("PUT", "/api/v0/delegation", { state: "on" }));

      // The same question and the same member's own settings, in the other company.
      await ok(zhou.call<Session>("POST", "/api/session", { tenant_id: lanting.id }));
      const inLanting = await ok(zhou.call<Me>("GET", "/api/v0/me"));
      expect([inLanting.tenant_id, inLanting.member_id, inLanting.admin]).toEqual([lanting.id, qinghe.maker, false]);
      expect(await spacesOf(zhou)).toEqual([lanting.space]);
      expect(await citedIn(zhou)).toEqual([lanting.document.source_version_id]);
      expect((await ok(zhou.call<Delegation>("GET", "/api/v0/delegation"))).state).toBe("unset");
      // Being super admin of Qinghe gives nothing in Lanting.
      expect(await refusal(zhou.call("POST", "/api/v0/spaces", { name: "Mine", owner_ids: [qinghe.maker] }))).toEqual([
        403,
        "forbidden",
      ]);
      expect((await zhou.call("GET", "/api/v0/usage")).status).toBe(403);
      expect((await zhou.call("GET", "/api/tokens?all=true")).status).toBe(403);
      expect((await zhou.call("POST", "/api/invites", {})).status).toBe(403);
    });

    test("a tab left showing the other company is refused before it acts, then reads only where the session is", async ({
      site,
    }) => {
      const { zhou, qinghe, lanting } = await world(site);
      const stale = zhou;
      const other = zhou.tab();
      const before = { qinghe: await holdings(stale) };
      await ok(other.call<Session>("POST", "/api/session", { tenant_id: lanting.id }));
      const inLanting = await holdings(other);

      const file = `/api/v0/spaces/${qinghe.space}/files/late.md`;
      for (const [method, path, body] of [
        ["GET", "/api/v0/spaces"],
        ["GET", `/api/v0/spaces/${qinghe.space}/documents`],
        ["GET", versionOf(qinghe)],
        ["POST", "/api/v0/search", { text: "hotels" }],
        ["POST", "/api/v0/answers", { question: "How much is a hotel night?" }],
        ["GET", "/api/members"],
        ["POST", "/api/invites", {}],
        ["POST", "/api/tokens", { name: "Late", spaces: "all", days: 30 }],
        ["POST", "/api/v0/spaces", { name: "Late", owner_ids: [qinghe.maker] }],
        ["PUT", `/api/v0/spaces/${qinghe.space}/audience`, { grants: [] }],
        ["PUT", file, new TextEncoder().encode("Late.")],
      ] as const) {
        expect([method, path, ...(await refusal(stale.call(method, path, body)))]).toEqual([
          method,
          path,
          409,
          "conflict",
        ]);
      }
      expect(await holdings(other)).toEqual(inLanting);

      // The page reads the session again, as the web app does after a 409, and shows Lanting.
      await ok(stale.call<Session>("GET", "/api/session"));
      expect(stale.company).toBe(lanting.id);
      expect(await spacesOf(stale)).toEqual([lanting.space]);
      const found = await search(stale);
      expect(found.hits.length).toBeGreaterThan(0);
      expect(found.hits.every((h) => h.space_id === lanting.space)).toBe(true);
      expect(JSON.stringify(found)).not.toContain(qinghe.word);

      await ok(other.call<Session>("POST", "/api/session", { tenant_id: qinghe.id }));
      expect(await holdings(other)).toEqual(before.qinghe);
    });

    test("after a switch whose answer was lost, and Back to a page of the company left, shows nothing of it", async ({
      site,
    }) => {
      const { zhou, qinghe, lanting } = await world(site);
      const token = await ok(
        zhou.call<CreatedAccessToken>("POST", "/api/tokens", { name: "CLI", spaces: "all", days: 30 }),
        201,
      );
      const invite = await ok(zhou.call<InviteLink>("POST", "/api/invites", {}), 201);

      // The switch to Lanting is made, but its answer never reaches the page.
      const tab = zhou.tab();
      await tab.call<Session>("POST", "/api/session", { tenant_id: lanting.id });
      tab.company = qinghe.id;
      expect(await refusal(tab.call("GET", "/api/v0/spaces"))).toEqual([409, "conflict"]);
      await ok(tab.call<Session>("GET", "/api/session"));
      expect(tab.company).toBe(lanting.id);

      // Back: the page shows Lanting again but opens Qinghe's space, document, token and invite
      // by the IDs in its address. Each is unknown here, though the same member runs them there.
      const space = `/api/v0/spaces/${qinghe.space}`;
      const { source_id, external_id } = qinghe.document;
      for (const [method, path, body] of [
        ["GET", versionOf(qinghe)],
        ["GET", `/api/v0/documents?${new URLSearchParams({ source: source_id, item: external_id })}`],
        ["GET", `${space}/documents`],
        ["GET", `${space}/topics`],
        ["GET", `${space}/overview`],
        ["GET", `${space}/audience`],
        ["PATCH", space, { name: "Taken" }],
        ["PUT", `${space}/audience`, { grants: [] }],
        ["PUT", `${space}/files/taken.md`, new TextEncoder().encode("Taken.")],
        ["POST", `/api/v0/sources/${source_id}/sync`, {}],
        ["DELETE", `/api/tokens/${token.token.id}`],
      ] as const) {
        expect([method, path, ...(await refusal(tab.call(method, path, body)))]).toEqual([
          method,
          path,
          404,
          "not_found",
        ]);
      }
      // A member of Lanting may not revoke links at all; Qinghe's stays open.
      expect(await refusal(tab.call("DELETE", `/api/invites/${invite.invite.id}`))).toEqual([403, "forbidden"]);

      // The other way round, with Qinghe's super admin rights: Lanting's objects are unknown in Qinghe.
      await ok(tab.call<Session>("POST", "/api/session", { tenant_id: qinghe.id }));
      const theirs = `/api/v0/spaces/${lanting.space}`;
      for (const [method, path, body] of [
        ["GET", versionOf(lanting)],
        ["GET", `${theirs}/documents`],
        ["GET", `${theirs}/audience`],
        ["PATCH", theirs, { name: "Taken" }],
        ["PUT", `${theirs}/owners`, { owner_ids: [qinghe.maker] }],
        ["PUT", `${theirs}/audience`, { grants: [] }],
        ["PUT", `/api/members/${lanting.maker}/role`, { role: "member" }],
        ["DELETE", `/api/members/${lanting.maker}`],
      ] as const) {
        expect([method, path, ...(await refusal(tab.call(method, path, body)))]).toEqual([
          method,
          path,
          404,
          "not_found",
        ]);
      }

      // Nothing was taken: Qinghe's token and link still work, Lanting's space is as it was.
      expect((await ok(tab.call<AccessTokenList>("GET", "/api/tokens"))).tokens.map((t) => t.id)).toEqual([
        token.token.id,
      ]);
      expect((await ok(tab.call<InviteList>("GET", "/api/invites"))).invites.map((i) => i.id)).toEqual([
        invite.invite.id,
      ]);
      await ok(tab.call<Session>("POST", "/api/session", { tenant_id: lanting.id }));
      const view = await ok(tab.call<DocumentView>("GET", versionOf(lanting)));
      expect(view.space_id).toBe(lanting.space);
      expect(await spacesOf(tab)).toEqual([lanting.space]);
    });

    test("a load that failed is retried in the company the session works in", async ({ site }) => {
      const { zhou, lanting } = await world(site);
      await site.stopEngine();
      expect((await zhou.call("GET", "/api/v0/spaces")).status).toBe(502);
      await ok(zhou.tab().call<Session>("POST", "/api/session", { tenant_id: lanting.id }));
      await site.startEngine();
      expect(await refusal(zhou.call("GET", "/api/v0/spaces"))).toEqual([409, "conflict"]);
      await ok(zhou.call<Session>("GET", "/api/session"));
      expect(await spacesOf(zhou)).toEqual([lanting.space]);
    });

    test("an MCP client reads only its token's company, though its member reads the other", async ({ site }) => {
      const { zhou, qinghe, lanting } = await world(site);
      const tokens = new Map<Company, string>();
      for (const company of [qinghe, lanting]) {
        await ok(zhou.call<Session>("POST", "/api/session", { tenant_id: company.id }));
        const made = await ok(
          zhou.call<CreatedAccessToken>("POST", "/api/tokens", { name: "Agent", spaces: "all", days: 30 }),
          201,
        );
        tokens.set(company, made.secret);
      }
      for (const [company, other] of [
        [qinghe, lanting],
        [lanting, qinghe],
      ] as const) {
        const secret = tokens.get(company) ?? "";
        const found = await mcp(site, secret, "search", { text: "hotels a night" });
        const hits = (found.result?.structuredContent as SearchResult | undefined)?.hits ?? [];
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.space_id === company.space)).toBe(true);
        expect(JSON.stringify(found.result)).not.toContain(other.word);
        const read = await mcp(site, secret, "read", { source_version_id: other.document.source_version_id });
        expect(read.result?.isError).toBe(true);
      }
    });

    test("an account or member outside a company gets nothing of it, from either layer", async ({ site }) => {
      const { zhou, zhang, qinghe, lanting } = await world(site);
      const li = await site.signIn(LI);
      expect((await ok(li.call<Session>("GET", "/api/session"))).companies).toEqual([]);
      for (const company of [qinghe, lanting]) {
        expect((await li.call("POST", "/api/session", { tenant_id: company.id })).status).toBe(404);
        expect(
          await refusal(li.call("GET", "/api/v0/spaces", undefined, { "x-inspiration-company": company.id })),
        ).toEqual([409, "conflict"]);
      }

      // Zhang removes Zhou from Lanting while Zhou's tab shows it, with an access token made there.
      await ok(zhou.call<Session>("POST", "/api/session", { tenant_id: lanting.id }));
      const made = await ok(
        zhou.call<CreatedAccessToken>("POST", "/api/tokens", { name: "Agent", spaces: "all", days: 30 }),
        201,
      );
      expect((await zhang.call("DELETE", `/api/members/${qinghe.maker}`)).status).toBe(204);
      expect(await refusal(zhou.call("GET", "/api/v0/spaces"))).toEqual([409, "conflict"]);
      const after = await ok(zhou.call<Session>("GET", "/api/session"));
      expect([after.companies.map((c) => c.tenant_id), after.current?.tenant_id]).toEqual([[qinghe.id], qinghe.id]);
      expect((await zhou.call("POST", "/api/session", { tenant_id: lanting.id })).status).toBe(404);
      expect((await mcp(site, made.secret, "search", { text: "hotels" })).status).toBe(401);
      expect(await spacesOf(zhou)).toEqual([qinghe.space]);

      // The engine refuses them on its own: a token the backend would never mint, for a member
      // who left or one who never belonged, is not let in.
      for (const [tenant_id, id] of [
        [lanting.id, qinghe.maker],
        [qinghe.id, lanting.maker],
      ]) {
        const token = site.tokens.member({ id, tenant_id } as Member, "en", new Date().toISOString());
        const res = await fetch(`${site.engineUrl}/v0/spaces`, { headers: { authorization: `Bearer ${token}` } });
        expect([tenant_id, res.status]).toEqual([tenant_id, 401]);
      }
    });
  });
});
