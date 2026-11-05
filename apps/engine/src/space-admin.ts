// The routes of the HTTP API for administering spaces, on access control's Directory, the
// spaces' system of record. The tenant's admins (the product's super admin) create spaces and
// name their owners; a space's owners and the tenant's admins rename it and read its audience;
// its owners set the audience, and the tenant's admins may only take grants out of it. An admin
// write on a space the member may read but not administer answers 403, so the page can say who
// may; a space they cannot read answers 404, as every read does, unless they administer it.

import type {
  CreateSpace,
  PatchSpace,
  Principal,
  PutSpaceAudience,
  PutSpaceOwners,
  SpaceAudience,
  SpaceEntry,
  SpaceList,
  SpaceRole,
  SpaceWritten,
  Tenant,
} from "@inspiration/contracts";
import { parseAs } from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { badRequest, forbidden, notFound, validated } from "./http-errors.ts";

/** Longer keys are refused, so a key stays a key and not a stored payload. */
const MAX_KEY = 200;

/**
 * The spaces the member may read, each with its owners and the member's role on it; with
 * manage, those they may administer instead, each with its number of grants and no content.
 * Both in the order the spaces were created, by space ID.
 */
export async function spaceList(engine: Engine, who: Principal, manage: boolean): Promise<SpaceList> {
  const all = await engine.directory.spaces(who.tenant_id);
  let listed: SpaceEntry[];
  if (manage) {
    const decisions = await engine.authz.checkMany(
      who,
      "admin",
      all.map((s) => ({ type: "space", id: s.id })),
    );
    listed = all.filter((_, i) => decisions[i]?.allow);
  } else {
    const readable = new Set((await engine.authz.scopeFilter(who, "read")).space_ids);
    listed = all.filter((s) => readable.has(s.id));
  }
  const roles = await engine.authz.spaceRoles(
    who,
    listed.map((s) => s.id),
  );
  const grants = manage ? await Promise.all(listed.map((s) => engine.directory.audience(s.id))) : [];
  return {
    tenant: (await engine.directory.tenant(who.tenant_id)) as Tenant,
    spaces: listed.map((s, i) => {
      const role = roles[i];
      const count = grants[i]?.grants.length;
      return { ...s, ...(role && { role }), ...(count !== undefined && { grants: count }) };
    }),
  };
}

/** Create a space: the tenant's admins only. The same Idempotency-Key answers the same space. */
export async function createSpace(
  engine: Engine,
  who: Principal,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<SpaceWritten> {
  const create = parseAs<CreateSpace>("CreateSpace", body);
  if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > MAX_KEY)) {
    throw badRequest(`an Idempotency-Key has 1 to ${MAX_KEY} characters`);
  }
  if (!(await administersTenant(engine, who))) throw forbidden("only the company's super admin creates spaces");
  const written = await validated(() =>
    engine.directory.createSpace(who.tenant_id, create, idempotencyKey === undefined ? {} : { idempotencyKey }),
  );
  return { ...written, space: await withRole(engine, who, written.space) };
}

/** Name a space's owners: the tenant's admins only. */
export async function putOwners(engine: Engine, who: Principal, spaceId: string, body: unknown): Promise<SpaceWritten> {
  const { owner_ids } = parseAs<PutSpaceOwners>("PutSpaceOwners", body);
  await administered(engine, who, spaceId);
  if (!(await administersTenant(engine, who))) throw forbidden("only the company's super admin names a space's owners");
  const written = await validated(() => engine.directory.putOwners(spaceId, owner_ids));
  return { ...written, space: await withRole(engine, who, written.space) };
}

/** Rename a space or change its description: its owners and the tenant's admins. */
export async function patchSpace(
  engine: Engine,
  who: Principal,
  spaceId: string,
  body: unknown,
): Promise<SpaceWritten> {
  const patch = parseAs<PatchSpace>("PatchSpace", body);
  await administered(engine, who, spaceId);
  const written = await validated(() => engine.directory.patchSpace(spaceId, patch));
  return { ...written, space: await withRole(engine, who, written.space) };
}

/** Who holds a role on a space, its owners first: for its owners and the tenant's admins. */
export async function audienceOf(engine: Engine, who: Principal, spaceId: string): Promise<SpaceAudience> {
  await administered(engine, who, spaceId);
  return (await engine.directory.audience(spaceId)) as SpaceAudience;
}

/**
 * Replace who reads a space. Its owners set it; a tenant admin who does not own the space may
 * only take grants out. Owner grants are left as they are (400 if the body changes them).
 */
export async function putAudience(
  engine: Engine,
  who: Principal,
  spaceId: string,
  body: unknown,
): Promise<SpaceAudience> {
  const { grants } = parseAs<PutSpaceAudience>("PutSpaceAudience", body);
  const role = await administered(engine, who, spaceId);
  if (role !== "owner") {
    const current = new Set(((await engine.directory.audience(spaceId))?.grants ?? []).map(grantKey));
    const added = grants.filter((g) => g.role !== "owner" && !current.has(grantKey(g)));
    if (added.length) throw forbidden("only the space's owners add to its audience; the super admin may only remove");
  }
  return validated(() => engine.directory.putAudience(spaceId, grants));
}

/**
 * The member's role on a space they may administer, undefined for a tenant admin without one.
 * 403 for a space they may only read, 404 for one they may not even read.
 */
async function administered(engine: Engine, who: Principal, spaceId: string): Promise<SpaceRole | undefined> {
  const entry = await engine.directory.space(spaceId);
  if (!entry || entry.tenant_id !== who.tenant_id) throw notFound("space");
  const space = { type: "space", id: spaceId } as const;
  const [admin, read] = await Promise.all([
    engine.authz.check(who, "admin", space),
    engine.authz.check(who, "read", space),
  ]);
  if (!admin.allow) {
    if (read.allow) throw forbidden("only the space's owners and the company's super admin change it");
    throw notFound("space");
  }
  return (await engine.authz.spaceRoles(who, [spaceId]))[0];
}

async function administersTenant(engine: Engine, who: Principal): Promise<boolean> {
  return (await engine.authz.check(who, "admin", { type: "tenant", id: who.tenant_id })).allow;
}

async function withRole(engine: Engine, who: Principal, space: SpaceEntry): Promise<SpaceEntry> {
  const [role] = await engine.authz.spaceRoles(who, [space.id]);
  return { ...space, ...(role && { role }) };
}

const grantKey = (g: { principal_id: string; role: string }) => `${g.principal_id}\0${g.role}`;
