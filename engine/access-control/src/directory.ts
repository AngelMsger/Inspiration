/**
 * The engine's copy of the business layer's directory, its tenants and their members, and the
 * spaces, which the engine keeps as their system of record. The records live in access
 * control's own schema (authz, migrations/0001_directory.sql) through Records, so the same
 * code runs on Postgres and in memory. The graph holds what the records grant, and only to
 * active members: an invited, suspended or departed member holds nothing, and a member
 * suspended and then restored gets back what the records still grant them. A member who
 * left loses their place in every audience and among the owners of every space, so a later
 * return brings nothing back, except where they were a space's last owner: a space always
 * names one, and stays theirs until new owners are named.
 *
 * Each write takes its tenant's lock, saves the records, then brings the graph in line with
 * them before it commits, so writers of one tenant take turns over both. Bringing a space in
 * line reads its relationships in the graph and removes those the records no longer grant;
 * it leaves alone grants to groups and departments, which the records cannot hold yet. A
 * write the graph missed is repaired by sending the same command again: a replay also brings
 * the graph in line.
 *
 * Tenants and members carry the business layer's version: a higher one wins, the same one
 * with the same content is a replay, and anything else is a ConflictError. Creating a space
 * with an idempotency key answers the space the key first created; the same key with another
 * request is a ConflictError.
 */

import {
  type CreateSpace,
  canonicalJson,
  contentHash,
  type DirectoryMember,
  type DirectoryMemberList,
  kindOf,
  type MemberWritten,
  newId,
  type PatchSpace,
  type PutMember,
  type PutTenant,
  type Space,
  type SpaceAudience,
  type SpaceEntry,
  type SpaceGrant,
  type SpaceOwnerIds,
  type SpaceRole,
  type SpaceWritten,
  type Tenant,
  type TenantWritten,
} from "@inspiration/contracts";
import { defineTable, type Records, type RecordTx } from "@inspiration/eventbus";
import { formatRelationship, type Graph, obj, type Relationship, rel, subject } from "./graph.ts";
import { SPACE_ROLES, subjectOf } from "./service.ts";
import { BULK_CHUNK } from "./spicedb.ts";

/** A command that contradicts the engine's copy, or an idempotency key sent with another request. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

interface TenantRecord {
  tenant: Tenant;
  /** The services that provisioned the tenant, each its system principal. */
  service_ids: string[];
}

/** A space with what it grants: its owners, in the order named, and its audience below them. */
interface SpaceRecord {
  space: Space;
  owner_ids: string[];
  audience: SpaceGrant[];
}

/** A space created with an idempotency key: the request's hash and the space it made. */
interface RequestRecord {
  tenant_id: string;
  key: string;
  request: string;
  space_id: string;
}

const TENANTS = defineTable<TenantRecord>("authz.tenants", { key: (t) => t.tenant.id });
const MEMBERS = defineTable<DirectoryMember>("authz.members", {
  key: (m) => `${m.tenant_id}|${m.id}`,
  columns: { tenant_id: (m) => m.tenant_id },
});
const SPACES = defineTable<SpaceRecord>("authz.spaces", {
  key: (s) => s.space.id,
  columns: { tenant_id: (s) => s.space.tenant_id },
});
const REQUESTS = defineTable<RequestRecord>("authz.requests", { key: (r) => `${r.tenant_id}|${r.key}` });

/** The roles the whole tenant may hold on a space, as the schema allows. */
const TENANT_ROLES: readonly SpaceRole[] = ["viewer", "commenter"];
/** The members a space may name: everyone who has not been suspended or left. */
const ASSIGNABLE = new Set(["invited", "active"]);

interface Updates {
  touch: Relationship[];
  delete: Relationship[];
}

export class Directory {
  readonly records: Records;
  readonly graph: Graph;
  readonly #now: () => Date;

  constructor(records: Records, graph: Graph, options: { now?: () => Date } = {}) {
    this.records = records;
    this.graph = graph;
    this.#now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ tenants and members

  /** Create or update a tenant, and register the calling service as its service. */
  async putTenant(tenantId: string, put: PutTenant, serviceId: string): Promise<TenantWritten> {
    expectKind(tenantId, "tenant");
    expectKind(serviceId, "service");
    return this.#write(tenantId, async (tx) => {
      const current = await tx.get(TENANTS, tenantId);
      const next: Tenant = {
        id: tenantId,
        name: put.name,
        kind: put.kind,
        status: put.status ?? "active",
        default_locale: put.default_locale,
        version: put.version,
        created_at: current?.tenant.created_at ?? this.#now().toISOString(),
      };
      const fresh = checkVersion(`tenant ${tenantId}`, current?.tenant, next, [
        "name",
        "kind",
        "status",
        "default_locale",
      ]);
      const record: TenantRecord = {
        tenant: fresh ? next : (current as TenantRecord).tenant,
        service_ids: [...new Set([...(current?.service_ids ?? []), serviceId])].sort(),
      };
      await tx.put(TENANTS, [record]);
      const tenant = obj("tenant", tenantId);
      const token = await this.#apply([
        { touch: record.service_ids.map((id) => rel(tenant, "service", subjectOf(tenantId, id))), delete: [] },
      ]);
      return { tenant: record.tenant, ...withToken(token) };
    });
  }

  async tenant(tenantId: string): Promise<Tenant | undefined> {
    return (await this.records.get(TENANTS, tenantId))?.tenant;
  }

  /** Create or update a member of a tenant; a member who is not active holds no grant. */
  async putMember(tenantId: string, memberId: string, put: PutMember): Promise<MemberWritten> {
    expectKind(memberId, "member");
    return this.#write(tenantId, async (tx) => {
      if (!(await tx.get(TENANTS, tenantId))) throw new RangeError(`no tenant ${tenantId}`);
      const current = await tx.get(MEMBERS, `${tenantId}|${memberId}`);
      const next: DirectoryMember = {
        id: memberId,
        tenant_id: tenantId,
        status: put.status,
        display_name: put.display_name,
        roles: [...put.roles].sort(),
        version: put.version,
        updated_at: this.#now().toISOString(),
      };
      const fresh = checkVersion(`member ${memberId}`, current, next, ["status", "display_name", "roles"]);
      const member = fresh ? next : (current as DirectoryMember);
      await tx.put(MEMBERS, [member]);

      const named = (await tx.find(SPACES, { tenant_id: tenantId })).filter(
        (s) => s.owner_ids.includes(memberId) || s.audience.some((g) => g.principal_id === memberId),
      );
      if (member.status === "left") {
        for (const s of named) {
          s.audience = s.audience.filter((g) => g.principal_id !== memberId);
          const owners = s.owner_ids.filter((id) => id !== memberId);
          if (owners.length) setOwners(s, owners);
        }
        await tx.put(SPACES, named);
      }
      const active = await this.#activeMembers(tx, tenantId);
      const token = await this.#apply([
        memberUpdates(member),
        ...(await Promise.all(named.map((s) => this.#spaceUpdates(s, active)))),
      ]);
      return { member, ...withToken(token) };
    });
  }

  async member(tenantId: string, memberId: string): Promise<DirectoryMember | undefined> {
    return this.records.get(MEMBERS, `${tenantId}|${memberId}`);
  }

  /** The tenant's members by member ID, the engine's copy, for checking drift. */
  async members(tenantId: string): Promise<DirectoryMemberList> {
    return { tenant_id: tenantId, members: await this.records.find(MEMBERS, { tenant_id: tenantId }) };
  }

  // ------------------------------------------------------------------------------ spaces

  /** Create a team space; a parent must be a space of the same tenant. */
  async createSpace(
    tenantId: string,
    create: CreateSpace,
    options: { idempotencyKey?: string } = {},
  ): Promise<SpaceWritten> {
    return this.#write(tenantId, async (tx) => {
      if (!(await tx.get(TENANTS, tenantId))) throw new RangeError(`no tenant ${tenantId}`);
      const request = contentHash(canonicalJson(create));
      const key = options.idempotencyKey;
      const earlier = key === undefined ? undefined : await tx.get(REQUESTS, `${tenantId}|${key}`);
      if (earlier && earlier.request !== request) {
        throw new ConflictError(`idempotency key ${JSON.stringify(key)} was sent with another request`);
      }
      let record = earlier && (await tx.get(SPACES, earlier.space_id));
      if (!record) {
        await assignable(tx, tenantId, create.owner_ids);
        if (create.parent_id) {
          const parent = await tx.get(SPACES, create.parent_id);
          if (parent?.space.tenant_id !== tenantId) throw new RangeError(`no space ${create.parent_id} in ${tenantId}`);
        }
        const space: Space = {
          id: newId("space"),
          tenant_id: tenantId,
          kind: "team",
          name: create.name,
          ...(create.description !== undefined && { description: create.description }),
          ...(create.parent_id !== undefined && { parent_id: create.parent_id }),
          owner_id: create.owner_ids[0],
          default_sensitivity: create.default_sensitivity ?? "internal",
          created_at: this.#now().toISOString(),
        };
        record = { space, owner_ids: [...create.owner_ids], audience: [] };
        await tx.put(SPACES, [record]);
        if (key !== undefined) await tx.put(REQUESTS, [{ tenant_id: tenantId, key, request, space_id: space.id }]);
      }
      return this.#writtenSpace(tx, record);
    });
  }

  /** Name a space's owners, the first of them its owner_id. */
  async putOwners(spaceId: string, ownerIds: SpaceOwnerIds): Promise<SpaceWritten> {
    return this.#writeSpace(spaceId, async (tx, record) => {
      await assignable(tx, record.space.tenant_id, ownerIds, new Set(record.owner_ids));
      setOwners(record, ownerIds);
      await tx.put(SPACES, [record]);
      return this.#writtenSpace(tx, record);
    });
  }

  /** Rename a space or change its description. */
  async patchSpace(spaceId: string, patch: PatchSpace): Promise<SpaceWritten> {
    return this.#writeSpace(spaceId, async (tx, record) => {
      if (patch.name !== undefined) record.space.name = patch.name;
      if (patch.description !== undefined) record.space.description = patch.description;
      await tx.put(SPACES, [record]);
      return this.#writtenSpace(tx, record);
    });
  }

  /**
   * Replace who reads a space. Owner grants may be sent back as the audience lists them and
   * are left alone; one that names anyone else is a RangeError, since owners are named with
   * putOwners. The whole tenant ("tenant") may view or comment; a member may hold one role.
   */
  async putAudience(spaceId: string, grants: readonly SpaceGrant[]): Promise<SpaceAudience> {
    return this.#writeSpace(spaceId, async (tx, record) => {
      const tenantId = record.space.tenant_id;
      const audience: SpaceGrant[] = [];
      for (const g of grants) {
        if (g.role === "owner") {
          if (!record.owner_ids.includes(g.principal_id)) {
            throw new RangeError(`${g.principal_id} is not an owner of ${spaceId}; owners are named on their own`);
          }
          continue;
        }
        if (g.principal_id === "tenant" && !TENANT_ROLES.includes(g.role)) {
          throw new RangeError(`the whole tenant may only view or comment, not hold ${g.role}`);
        }
        if (audience.some((a) => a.principal_id === g.principal_id)) {
          throw new RangeError(`${g.principal_id} is granted more than one role on ${spaceId}`);
        }
        audience.push({ principal_id: g.principal_id, role: g.role });
      }
      await assignable(
        tx,
        tenantId,
        audience.flatMap((g) => (g.principal_id === "tenant" ? [] : [g.principal_id])),
        new Set(record.audience.map((g) => g.principal_id)),
      );
      record.audience = audience.sort(byGrant);
      await tx.put(SPACES, [record]);
      const token = await this.#apply([await this.#spaceUpdates(record, await this.#activeMembers(tx, tenantId))]);
      return { ...audienceOf(record), ...withToken(token) };
    });
  }

  async space(spaceId: string): Promise<SpaceEntry | undefined> {
    const record = await this.records.get(SPACES, spaceId);
    return record && entryOf(record);
  }

  /** A tenant's spaces, by space ID, which is the order they were created in. */
  async spaces(tenantId: string): Promise<SpaceEntry[]> {
    return (await this.records.find(SPACES, { tenant_id: tenantId })).map(entryOf);
  }

  /** Who holds a role on the space: its owners first, as owner grants, then its audience. */
  async audience(spaceId: string): Promise<SpaceAudience | undefined> {
    const record = await this.records.get(SPACES, spaceId);
    return record && audienceOf(record);
  }

  // ----------------------------------------------------------------------------- internals

  /** A write in the tenant's turn: writers of one tenant wait for each other. */
  async #write<R>(tenantId: string, fn: (tx: RecordTx) => Promise<R>): Promise<R> {
    expectKind(tenantId, "tenant");
    return this.records.transaction(async (tx) => {
      await tx.lock(`authz.directory:${tenantId}`);
      return fn(tx);
    });
  }

  async #writeSpace<R>(spaceId: string, fn: (tx: RecordTx, record: SpaceRecord) => Promise<R>): Promise<R> {
    const tenantId = (await this.records.get(SPACES, spaceId))?.space.tenant_id;
    if (!tenantId) throw new RangeError(`no space ${spaceId}`);
    return this.#write(tenantId, async (tx) => fn(tx, (await tx.get(SPACES, spaceId)) as SpaceRecord));
  }

  async #writtenSpace(tx: RecordTx, record: SpaceRecord): Promise<SpaceWritten> {
    const active = await this.#activeMembers(tx, record.space.tenant_id);
    const token = await this.#apply([await this.#spaceUpdates(record, active)]);
    return { space: entryOf(record), ...withToken(token) };
  }

  async #activeMembers(tx: RecordTx, tenantId: string): Promise<Set<string>> {
    const members = await tx.find(MEMBERS, { tenant_id: tenantId });
    return new Set(members.filter((m) => m.status === "active").map((m) => m.id));
  }

  /**
   * What brings a space's relationships in line with its record: its tenant and parent, then
   * its owners' and audience's roles for active members, and the removal of any other member
   * or whole-tenant role the graph holds on it.
   */
  async #spaceUpdates(record: SpaceRecord, active: ReadonlySet<string>): Promise<Updates> {
    const { space } = record;
    const t = space.tenant_id;
    const ref = obj("space", space.id);
    const wanted = [rel(ref, "tenant", subject("tenant", t))];
    if (space.parent_id) wanted.push(rel(ref, "parent", subject("space", space.parent_id)));
    for (const id of record.owner_ids) if (active.has(id)) wanted.push(rel(ref, "owner", subjectOf(t, id)));
    for (const g of record.audience) {
      if (g.principal_id === "tenant") wanted.push(rel(ref, g.role, subjectOf(t, t)));
      else if (active.has(g.principal_id)) wanted.push(rel(ref, g.role, subjectOf(t, g.principal_id)));
    }
    const keep = new Set(wanted.map(formatRelationship));
    const held = await this.graph.read("space", space.id);
    const managed = (r: Relationship) =>
      r.relation === "tenant" ||
      r.relation === "parent" ||
      (SPACE_ROLES.includes(r.relation as SpaceRole) && (r.subject.type === "member" || r.subject.type === "tenant"));
    return { touch: wanted, delete: held.filter((r) => managed(r) && !keep.has(formatRelationship(r))) };
  }

  /** Write the updates in as few graph writes as SpiceDB takes, and return the last token. */
  async #apply(updates: readonly Updates[]): Promise<string | undefined> {
    const touch = new Map(updates.flatMap((u) => u.touch).map((r) => [formatRelationship(r), r] as const));
    const remove = new Map(
      updates
        .flatMap((u) => u.delete)
        .filter((r) => !touch.has(formatRelationship(r)))
        .map((r) => [formatRelationship(r), r] as const),
    );
    const ops = [
      ...[...remove.values()].map((r) => ["delete", r] as const),
      ...[...touch.values()].map((r) => ["touch", r] as const),
    ];
    let token = this.graph.token;
    for (let i = 0; i < ops.length; i += BULK_CHUNK) {
      const part = ops.slice(i, i + BULK_CHUNK);
      token = await this.graph.write({
        delete: part.filter(([op]) => op === "delete").map(([, r]) => r),
        touch: part.filter(([op]) => op === "touch").map(([, r]) => r),
      });
    }
    return token;
  }
}

// ------------------------------------------------------------------------------- helpers

function expectKind(id: string, kind: "tenant" | "member" | "service"): void {
  if (kindOf(id) !== kind) throw new RangeError(`${id} is not a ${kind} ID`);
}

/**
 * Whether a versioned command is new (true) or a replay (false): a higher version than the
 * copy's is new, the same version with the same fields is a replay, anything else conflicts.
 */
function checkVersion<T extends { version?: number }>(
  what: string,
  current: T | undefined,
  next: T,
  fields: readonly (keyof T)[],
): boolean {
  if (current?.version === undefined || (next.version as number) > current.version) return true;
  if (next.version === current.version && fields.every((f) => canonicalJson(current[f]) === canonicalJson(next[f]))) {
    return false;
  }
  const differs = next.version === current.version ? " with other content" : "";
  throw new ConflictError(
    `${what} is at version ${current.version}; version ${next.version}${differs} does not replace it`,
  );
}

/**
 * Owners and audience name members of the tenant who are invited or active. One the space
 * already names may stay while suspended, so a list read back and sent again still holds.
 */
async function assignable(
  tx: RecordTx,
  tenantId: string,
  memberIds: readonly string[],
  named: ReadonlySet<string> = new Set(),
): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length !== memberIds.length) throw new RangeError("a member is named twice");
  const members = await tx.getMany(
    MEMBERS,
    unique.map((id) => `${tenantId}|${id}`),
  );
  const statusOf = new Map(members.map((m) => [m.id, m.status] as const));
  for (const id of unique) {
    const status = statusOf.get(id);
    if (!status || !(ASSIGNABLE.has(status) || (status === "suspended" && named.has(id)))) {
      throw new RangeError(`${id} is not an invited or active member of ${tenantId}`);
    }
  }
}

function memberUpdates(m: DirectoryMember): Updates {
  const tenant = obj("tenant", m.tenant_id);
  const s = subjectOf(m.tenant_id, m.id);
  const member = rel(tenant, "member", s);
  const admin = rel(tenant, "admin", s);
  if (m.status !== "active") return { touch: [], delete: [member, admin] };
  return m.roles.includes("admin") ? { touch: [member, admin], delete: [] } : { touch: [member], delete: [admin] };
}

function setOwners(record: SpaceRecord, ownerIds: readonly string[]): void {
  record.owner_ids = [...ownerIds];
  record.space.owner_id = ownerIds[0] as string;
}

/** SPACE_ROLES runs from the highest role down. */
const RANK = new Map(SPACE_ROLES.map((role, i) => [role, i]));

/** Higher roles first, then by principal. */
function byGrant(a: SpaceGrant, b: SpaceGrant): number {
  return (
    (RANK.get(a.role) ?? 0) - (RANK.get(b.role) ?? 0) ||
    (a.principal_id < b.principal_id ? -1 : a.principal_id > b.principal_id ? 1 : 0)
  );
}

function entryOf(record: SpaceRecord): SpaceEntry {
  return { ...record.space, owner_ids: record.owner_ids as SpaceOwnerIds };
}

function audienceOf(record: SpaceRecord): SpaceAudience {
  return {
    space_id: record.space.id,
    grants: [...record.owner_ids.map((id): SpaceGrant => ({ principal_id: id, role: "owner" })), ...record.audience],
  };
}

function withToken(token: string | undefined): { consistency_token?: string } {
  return token === undefined ? {} : { consistency_token: token };
}
