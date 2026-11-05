// Provisioning and space administration over HTTP, on an engine with nothing in it yet: the
// tenancy service provisions a tenant and its members, the super admin creates a space and
// names its owner, the owner sets who reads it, and each answer keeps to its contract.

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Jwks, jwksFromUrl, TokenVerifier } from "@inspiration/access-control";
import { devIssuer } from "@inspiration/access-control/testing";
import { contractErrors, type PutMember } from "@inspiration/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Engine, serveApi } from "../src/index.ts";

const TENANT = "ten_01QINGHE000000000000000001";
const OTHER = "ten_01QINGHE000000000000000002";
const SERVICE = "svc_01TENANCY0000000000000000";
const ADMIN = "mem_01QINGHE00000000000000ADMIN"; // the super admin
const ZHOU = "mem_01QINGHE0000000000ZHOUMIN";
const LINA = "mem_01QINGHE00000000000000LINA";

const issuer = devIssuer();
let engine: Engine;
let server: Server;
let blobs: string;

beforeAll(async () => {
  blobs = await mkdtemp(join(tmpdir(), "inspiration-directory-"));
  engine = await Engine.open({ blobDir: blobs });
  server = await serveApi(engine, 0, {
    tokens: new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys: issuer.keys }),
  });
});

afterAll(async () => {
  server?.close();
  await engine?.close();
  await rm(blobs, { recursive: true, force: true });
});

interface Call {
  method?: string;
  /** A member ID, or a service ID for the tenancy service. */
  as?: string;
  tenant?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(path: string, options: Call = {}) {
  const { port } = server.address() as AddressInfo;
  const sub = options.as ?? ZHOU;
  const kind = sub.startsWith("svc_") ? "service" : "member";
  const token = issuer.mint({ sub, tid: options.tenant ?? TENANT, kind, locale: "zh-CN" });
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, ...options.headers },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const tenant = { name: "Qinghe Tech", kind: "team", default_locale: "zh-CN", version: 1 };
const member = (name: string, version = 1, roles: PutMember["roles"] = ["member"]): PutMember => ({
  status: "active",
  display_name: name,
  roles,
  version,
});
const putMember = (id: string, body: PutMember) =>
  call(`/v0/tenants/${TENANT}/members/${id}`, { method: "PUT", as: SERVICE, body });
const errorCode = (body: Record<string, unknown>) => (body.error as { code: string }).code;

let space: string;

describe("provisioning", () => {
  test("creates the tenant for its own service, and nobody else", async () => {
    const { status, body } = await call(`/v0/tenants/${TENANT}`, { method: "PUT", as: SERVICE, body: tenant });
    expect(status).toBe(200);
    expect(contractErrors("TenantWritten", body)).toEqual([]);
    expect(body.tenant).toMatchObject({ id: TENANT, name: "Qinghe Tech", status: "active", version: 1 });
    expect(body.consistency_token).toBeDefined();
    const elsewhere = await call(`/v0/tenants/${OTHER}`, { method: "PUT", as: SERVICE, body: tenant });
    expect(elsewhere.status).toBe(403);
    const asMember = await call(`/v0/tenants/${TENANT}`, { method: "PUT", body: tenant });
    expect(asMember.status).toBe(403);
  });

  test("keeps its members, by version, for the drift check", async () => {
    expect(
      (await putMember(ADMIN, member("Gao Admin", 1, ["owner", "admin", "security_admin", "auditor"]))).status,
    ).toBe(200);
    const zhou = await putMember(ZHOU, member("Zhou Min"));
    expect(zhou.status).toBe(200);
    expect(contractErrors("MemberWritten", zhou.body)).toEqual([]);
    expect((await putMember(LINA, member("Li Na"))).status).toBe(200);
    const stale = await putMember(ZHOU, member("Zhou Min (old)"));
    expect([stale.status, errorCode(stale.body)]).toEqual([409, "conflict"]);
    expect((await putMember(ZHOU, member("Zhou Min"))).status).toBe(200); // a replay
    expect((await putMember("svc_01NOTAMEMBER00000000000000", member("x"))).status).toBe(400);
    expect((await putMember(LINA, { ...member("Li Na"), roles: [] } as unknown as PutMember)).status).toBe(400);
    const unknown = await call(`/v0/tenants/${OTHER}/members/${ZHOU}`, {
      method: "PUT",
      as: SERVICE,
      tenant: OTHER,
      body: member("Zhou Min"),
    });
    expect(unknown.status).toBe(404);

    const { status, body } = await call(`/v0/tenants/${TENANT}/members`, { as: SERVICE });
    expect(status).toBe(200);
    expect(contractErrors("DirectoryMemberList", body)).toEqual([]);
    expect((body.members as { id: string }[]).map((m) => m.id)).toEqual([ADMIN, LINA, ZHOU].sort());
  });

  test("lets in only active members of an active tenant", async () => {
    const stranger = await call("/v0/me", { as: "mem_01QINGHE00000000000STRANGER" });
    expect(stranger.status).toBe(401);
    expect((await call("/v0/me", { tenant: OTHER })).status).toBe(401);
    const { status, body } = await call("/v0/me");
    expect(status).toBe(200);
    expect(contractErrors("Me", body)).toEqual([]);
    expect(body).toEqual({ tenant_id: TENANT, member_id: ZHOU, roles: ["member"], admin: false, locale: "zh-CN" });
    expect((await call("/v0/me", { as: ADMIN })).body).toMatchObject({
      roles: ["admin", "auditor", "owner", "security_admin"],
      admin: true,
    });
  });
});

describe("space administration", () => {
  test("lets only the super admin create a space, once per idempotency key", async () => {
    const create = { name: "Finance", owner_ids: [ZHOU] };
    const refused = await call("/v0/spaces", { body: create });
    expect([refused.status, errorCode(refused.body)]).toEqual([403, "forbidden"]);
    const headers = { "idempotency-key": "create-finance" };
    const created = await call("/v0/spaces", { as: ADMIN, body: create, headers });
    expect(created.status).toBe(200);
    expect(contractErrors("SpaceWritten", created.body)).toEqual([]);
    const entry = created.body.space as { id: string; owner_ids: string[]; role?: string };
    expect(entry).toMatchObject({ name: "Finance", kind: "team", owner_id: ZHOU, owner_ids: [ZHOU] });
    expect(entry.role).toBeUndefined(); // the super admin manages it without a role on it
    space = entry.id;
    const again = await call("/v0/spaces", { as: ADMIN, body: create, headers });
    expect((again.body.space as { id: string }).id).toBe(space);
    const reused = await call("/v0/spaces", { as: ADMIN, body: { ...create, name: "Sales" }, headers });
    expect(reused.status).toBe(409);
    const badOwner = await call("/v0/spaces", { as: ADMIN, body: { name: "X", owner_ids: [LINA, LINA] } });
    expect(badOwner.status).toBe(400);
  });

  test("lists for the super admin what they manage, and not what they cannot read", async () => {
    const read = await call("/v0/spaces", { as: ADMIN });
    expect((read.body.spaces as unknown[]).length).toBe(0);
    const managed = await call("/v0/spaces?manage=true", { as: ADMIN });
    expect(contractErrors("SpaceList", managed.body)).toEqual([]);
    expect(managed.body.spaces).toMatchObject([{ id: space, owner_ids: [ZHOU], grants: 1 }]);
    const owner = await call("/v0/spaces?manage=true");
    expect(owner.body.spaces).toMatchObject([{ id: space, role: "owner", grants: 1 }]);
    expect((await call("/v0/spaces?manage=true", { as: LINA })).body.spaces).toEqual([]);
  });

  test("lets the owner set who reads it, and answers others 404 or 403", async () => {
    expect((await call(`/v0/spaces/${space}/audience`, { as: LINA })).status).toBe(404);
    const grants = [{ principal_id: "tenant", role: "viewer" }];
    const set = await call(`/v0/spaces/${space}/audience`, { method: "PUT", body: { grants } });
    expect(set.status).toBe(200);
    expect(contractErrors("SpaceAudience", set.body)).toEqual([]);
    expect(set.body.grants).toEqual([{ principal_id: ZHOU, role: "owner" }, ...grants]);

    const lina = await call("/v0/spaces", { as: LINA });
    expect(lina.body.spaces).toMatchObject([{ id: space, role: "viewer" }]);
    expect((await call(`/v0/spaces/${space}/audience`, { as: LINA })).status).toBe(403);
    const rename = await call(`/v0/spaces/${space}`, { method: "PATCH", as: LINA, body: { name: "Fin" } });
    expect([rename.status, errorCode(rename.body)]).toEqual([403, "forbidden"]);
    const ownerGrant = await call(`/v0/spaces/${space}/audience`, {
      method: "PUT",
      body: { grants: [{ principal_id: LINA, role: "owner" }] },
    });
    expect(ownerGrant.status).toBe(400);
  });

  test("lets the super admin take grants out of an audience but not add to it", async () => {
    const add = await call(`/v0/spaces/${space}/audience`, {
      method: "PUT",
      as: ADMIN,
      body: {
        grants: [
          { principal_id: "tenant", role: "viewer" },
          { principal_id: LINA, role: "editor" },
        ],
      },
    });
    expect(add.status).toBe(403);
    const remove = await call(`/v0/spaces/${space}/audience`, { method: "PUT", as: ADMIN, body: { grants: [] } });
    expect(remove.status).toBe(200);
    expect((await call("/v0/spaces", { as: LINA })).body.spaces).toEqual([]);
  });

  test("lets the owner rename it and only the super admin name its owners", async () => {
    const renamed = await call(`/v0/spaces/${space}`, { method: "PATCH", body: { name: "Finance and Tax" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.space).toMatchObject({ name: "Finance and Tax", role: "owner" });
    const owners = { owner_ids: [LINA] };
    expect((await call(`/v0/spaces/${space}/owners`, { method: "PUT", body: owners })).status).toBe(403);
    const named = await call(`/v0/spaces/${space}/owners`, { method: "PUT", as: ADMIN, body: owners });
    expect(named.status).toBe(200);
    expect(named.body.space).toMatchObject({ owner_id: LINA, owner_ids: [LINA] });
    expect((await call(`/v0/spaces/${space}/audience`)).status).toBe(404); // Zhou Min no longer reads it
    expect((await call(`/v0/spaces/${space}/audience`, { as: LINA })).status).toBe(200);
  });

  test("shuts out a member once suspended, and everyone once the tenant is", async () => {
    expect((await putMember(LINA, { ...member("Li Na", 2), status: "suspended" })).status).toBe(200);
    expect((await call("/v0/spaces", { as: LINA })).status).toBe(401);
    await call(`/v0/tenants/${TENANT}`, {
      method: "PUT",
      as: SERVICE,
      body: { ...tenant, status: "suspended", version: 2 },
    });
    expect((await call("/v0/me")).status).toBe(401);
  });
});

describe("signing keys", () => {
  test("a key the issuer retired provisions nothing once the cached keys are past their lifetime", async () => {
    const tenantId = "ten_01QINGHE000000000000000003";
    const retiring = devIssuer({ issuer: issuer.issuer, audience: issuer.audience, kid: "dev-retiring" });
    let published: Jwks = { keys: [...issuer.jwks.keys, ...retiring.jwks.keys] };
    let clock = 0;
    const keys = jwksFromUrl("https://business.example/.well-known/jwks.json", {
      maxAgeMs: 300_000,
      now: () => clock,
      fetch: async () => new Response(JSON.stringify(published)),
    });
    const rotating = await serveApi(engine, 0, {
      tokens: new TokenVerifier({ issuer: issuer.issuer, audience: issuer.audience, keys }),
    });
    try {
      const put = (signer: ReturnType<typeof devIssuer>, path: string, body: unknown) => {
        const { port } = rotating.address() as AddressInfo;
        const token = signer.mint({ sub: SERVICE, tid: tenantId, kind: "service" });
        return fetch(`http://127.0.0.1:${port}/v0/tenants/${tenantId}${path}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      };
      expect((await put(retiring, "", tenant)).status).toBe(200); // the key is published, and cached
      published = issuer.jwks; // the issuer retires it
      clock = 301_000;
      expect((await put(retiring, `/members/${ZHOU}`, member("Zhou Min"))).status).toBe(401);
      expect(await engine.directory.member(tenantId, ZHOU)).toBeUndefined();
      expect((await put(issuer, `/members/${ZHOU}`, member("Zhou Min"))).status).toBe(200); // the current key holds
    } finally {
      rotating.close();
    }
  });
});
