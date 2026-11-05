// The directory copy and the spaces: records in memory or on Postgres, the graph they grant
// in memory or on SpiceDB.

import { newId, type Principal, type PutMember, type PutTenant, type SpaceRole } from "@inspiration/contracts";
import { MemoryRecords, PgRecords, type Records } from "@inspiration/eventbus";
import { openPool } from "@inspiration/kernel";
import { MemoryStore } from "@inspiration/knowledge-store";
import { createTestDatabase, hasStack, SPICEDB_ENDPOINT, SPICEDB_KEY } from "@inspiration/testkit";
import { describe, expect, test as unitTest } from "vitest";
import {
  AuthzService,
  ConflictError,
  closeClient,
  connect,
  Directory,
  type Graph,
  MemoryGraph,
  SpiceDBGraph,
  writeSchema,
} from "../src/index.ts";

type Backend = "memory" | "stack";
const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "stack", skip: !hasStack() },
];

const TENANT: PutTenant = { name: "Qinghe", kind: "team", default_locale: "zh-CN", version: 1 };
const active = (version = 1, roles: PutMember["roles"] = ["member"]): PutMember => ({
  status: "active",
  display_name: "Zhou Min",
  roles,
  version,
});

/** A tenant with a service and three active members (an admin among them), and helpers to read the graph. */
class World {
  readonly tenant = newId("tenant");
  readonly service = newId("service");
  readonly zhou = newId("member");
  readonly lina = newId("member");
  readonly admin = newId("member");
  readonly directory: Directory;
  readonly authz: AuthzService;

  constructor(records: Records, graph: Graph) {
    this.directory = new Directory(records, graph);
    this.authz = new AuthzService(graph, new MemoryStore());
  }

  async build(): Promise<this> {
    await this.directory.putTenant(this.tenant, TENANT, this.service);
    await this.directory.putMember(this.tenant, this.zhou, active());
    await this.directory.putMember(this.tenant, this.lina, active());
    await this.directory.putMember(this.tenant, this.admin, active(1, ["admin", "auditor", "owner", "security_admin"]));
    return this;
  }

  who(id: string): Principal {
    return { id, kind: "member", tenant_id: this.tenant };
  }

  async role(memberId: string, spaceId: string): Promise<SpaceRole | undefined> {
    return (await this.authz.spaceRoles(this.who(memberId), [spaceId]))[0];
  }

  async reads(memberId: string, spaceId: string): Promise<boolean> {
    return (await this.authz.check(this.who(memberId), "read", { type: "space", id: spaceId })).allow;
  }

  async space(name = "Finance", owners = [this.zhou]) {
    return (await this.directory.createSpace(this.tenant, { name, owner_ids: owners as [string, ...string[]] })).space;
  }
}

let schemaWritten: Promise<string> | undefined;

function directoryTest(backend: Backend) {
  return (
    unitTest
      // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
      .extend("records", async ({}, { onCleanup }): Promise<Records> => {
        if (backend === "memory") return new MemoryRecords();
        const db = await createTestDatabase();
        const pool = await openPool(db.url);
        onCleanup(async () => {
          await pool.end();
          await db.drop();
        });
        return new PgRecords(pool);
      })
      // biome-ignore lint/correctness/noEmptyPattern: as above
      .extend("graph", async ({}, { onCleanup }): Promise<Graph> => {
        if (backend === "memory") return new MemoryGraph();
        // Every test uses fresh IDs, so SpiceDB tests share one instance without clearing it.
        const client = connect(SPICEDB_ENDPOINT, SPICEDB_KEY, { insecure: true });
        onCleanup(() => closeClient(client));
        schemaWritten ??= writeSchema(client);
        await schemaWritten;
        return new SpiceDBGraph(client);
      })
      .extend("w", async ({ records, graph }) => new World(records, graph).build())
  );
}

describe.each(BACKENDS)("the directory on $backend", ({ backend, skip }) => {
  const test = directoryTest(backend);

  describe("tenants", () => {
    test.skipIf(skip)("are created once and registered to the service that provisions them", async ({ w }) => {
      const tenant = await w.directory.tenant(w.tenant);
      expect(tenant).toMatchObject({ id: w.tenant, name: "Qinghe", kind: "team", status: "active", version: 1 });
      const service: Principal = { id: w.service, kind: "service", tenant_id: w.tenant };
      expect(await w.authz.principalTokens(service)).toEqual([`system:${w.tenant}`]);
    });

    test.skipIf(skip)("take a higher version, replay the same one, and refuse anything else", async ({ w }) => {
      const first = await w.directory.tenant(w.tenant);
      const replay = await w.directory.putTenant(w.tenant, TENANT, w.service);
      expect(replay.tenant).toEqual(first);
      expect(replay.consistency_token).toBeDefined();
      const renamed = await w.directory.putTenant(w.tenant, { ...TENANT, name: "Qinghe Ltd", version: 3 }, w.service);
      expect(renamed.tenant).toMatchObject({ name: "Qinghe Ltd", version: 3, created_at: first?.created_at });
      await expect(w.directory.putTenant(w.tenant, { ...TENANT, version: 2 }, w.service)).rejects.toThrow(
        ConflictError,
      );
      await expect(
        w.directory.putTenant(w.tenant, { ...TENANT, name: "Other", version: 3 }, w.service),
      ).rejects.toThrow(/at version 3; version 3 with other content/);
    });
  });

  describe("members", () => {
    test.skipIf(skip)("belong to a known tenant and are listed by member ID", async ({ w }) => {
      await expect(w.directory.putMember(newId("tenant"), newId("member"), active())).rejects.toThrow(/no tenant/);
      await expect(w.directory.putMember(w.tenant, w.service, active())).rejects.toThrow(/not a member ID/);
      const { members } = await w.directory.members(w.tenant);
      expect(members.map((m) => m.id)).toEqual([w.zhou, w.lina, w.admin].sort());
      expect(members.find((m) => m.id === w.admin)?.roles).toEqual(["admin", "auditor", "owner", "security_admin"]);
    });

    test.skipIf(skip)("hold the tenant's admin permission with the admin role, and lose it without", async ({ w }) => {
      const administers = async (id: string) =>
        (await w.authz.check(w.who(id), "admin", { type: "tenant", id: w.tenant })).allow;
      expect(await administers(w.admin)).toBe(true);
      expect(await administers(w.zhou)).toBe(false);
      await w.directory.putMember(w.tenant, w.admin, active(2));
      expect(await administers(w.admin)).toBe(false);
      await expect(w.directory.putMember(w.tenant, w.admin, active(1))).rejects.toThrow(ConflictError);
    });

    test.skipIf(skip)("hold nothing while invited, and what the space grants once active", async ({ w }) => {
      const invited = newId("member");
      await w.directory.putMember(w.tenant, invited, { ...active(), status: "invited" });
      const space = await w.space("Finance", [invited]);
      expect(await w.authz.principalTokens(w.who(invited))).toEqual([]);
      expect(await w.role(invited, space.id)).toBeUndefined();
      await w.directory.putMember(w.tenant, invited, active(2));
      expect(await w.authz.principalTokens(w.who(invited))).toEqual([`tenant:${w.tenant}`]);
      expect(await w.role(invited, space.id)).toBe("owner");
    });

    test.skipIf(skip)("lose every grant while suspended and get them back when restored", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      const company = await w.space("Company", [w.admin]);
      await w.directory.putAudience(space.id, [{ principal_id: w.lina, role: "editor" }]);
      await w.directory.putAudience(company.id, [{ principal_id: "tenant", role: "viewer" }]);
      expect(await w.role(w.lina, space.id)).toBe("editor");
      expect(await w.reads(w.zhou, company.id)).toBe(true);

      await w.directory.putMember(w.tenant, w.lina, { ...active(2), status: "suspended" });
      await w.directory.putMember(w.tenant, w.zhou, { ...active(2), status: "suspended" });
      expect(await w.role(w.lina, space.id)).toBeUndefined();
      expect(await w.role(w.zhou, space.id)).toBeUndefined();
      expect(await w.reads(w.zhou, company.id)).toBe(false);
      expect((await w.directory.audience(space.id))?.grants).toEqual([
        { principal_id: w.zhou, role: "owner" },
        { principal_id: w.lina, role: "editor" },
      ]);

      // The audience read back and sent again keeps the suspended member; a new one is refused.
      const { grants } = (await w.directory.audience(space.id)) ?? { grants: [] };
      await w.directory.putAudience(space.id, grants);
      await expect(w.directory.putOwners(space.id, [w.zhou, w.lina])).rejects.toThrow(/not an invited or active/);

      await w.directory.putMember(w.tenant, w.lina, active(3));
      expect(await w.role(w.lina, space.id)).toBe("editor");
    });

    test.skipIf(skip)(
      "who left lose their audience grants and ownerships, but stay named as a last owner",
      async ({ w }) => {
        const shared = await w.space("Finance", [w.zhou, w.lina]);
        const own = await w.space("Budget", [w.lina]);
        const sales = await w.space("Sales", [w.zhou]);
        await w.directory.putAudience(sales.id, [{ principal_id: w.lina, role: "viewer" }]);

        await w.directory.putMember(w.tenant, w.lina, { ...active(2), status: "left" });
        expect(await w.directory.space(shared.id)).toMatchObject({ owner_ids: [w.zhou], owner_id: w.zhou });
        expect(await w.directory.space(own.id)).toMatchObject({ owner_ids: [w.lina] });
        expect((await w.directory.audience(sales.id))?.grants).toEqual([{ principal_id: w.zhou, role: "owner" }]);
        expect(await w.role(w.lina, own.id)).toBeUndefined();

        // Back again: only what the records still name, the space nobody else owns.
        await w.directory.putMember(w.tenant, w.lina, active(3));
        expect(await w.role(w.lina, shared.id)).toBeUndefined();
        expect(await w.role(w.lina, sales.id)).toBeUndefined();
        expect(await w.role(w.lina, own.id)).toBe("owner");
      },
    );
  });

  describe("spaces", () => {
    test.skipIf(skip)("are team spaces the engine names, owned by their first owner", async ({ w }) => {
      const written = await w.directory.createSpace(w.tenant, {
        name: "Finance",
        description: "Policies and budgets",
        owner_ids: [w.lina, w.zhou],
      });
      expect(written.space).toMatchObject({
        tenant_id: w.tenant,
        kind: "team",
        name: "Finance",
        description: "Policies and budgets",
        owner_id: w.lina,
        owner_ids: [w.lina, w.zhou],
        default_sensitivity: "internal",
      });
      expect(written.space.id).toMatch(/^spc_/);
      expect(written.consistency_token).toBeDefined();
      expect(await w.role(w.zhou, written.space.id)).toBe("owner");
      expect(await w.role(w.admin, written.space.id)).toBeUndefined();
      expect((await w.directory.spaces(w.tenant)).map((s) => s.id)).toEqual([written.space.id]);
    });

    test.skipIf(skip)("are created once per idempotency key", async ({ w }) => {
      const create = { name: "Finance", owner_ids: [w.zhou] as [string] };
      const first = await w.directory.createSpace(w.tenant, create, { idempotencyKey: "k1" });
      const again = await w.directory.createSpace(w.tenant, create, { idempotencyKey: "k1" });
      expect(again.space).toEqual(first.space);
      await expect(
        w.directory.createSpace(w.tenant, { ...create, name: "Sales" }, { idempotencyKey: "k1" }),
      ).rejects.toThrow(ConflictError);
      const other = await w.directory.createSpace(w.tenant, create);
      expect(other.space.id).not.toBe(first.space.id);
    });

    test.skipIf(skip)("name only invited or active members, and a parent of their own tenant", async ({ w }) => {
      await expect(w.space("Finance", [newId("member")])).rejects.toThrow(/not an invited or active member/);
      await w.directory.putMember(w.tenant, w.lina, { ...active(2), status: "suspended" });
      await expect(w.space("Finance", [w.lina])).rejects.toThrow(RangeError);
      await expect(w.space("Finance", [w.zhou, w.zhou])).rejects.toThrow(/named twice/);
      await expect(
        w.directory.createSpace(w.tenant, { name: "Budget", owner_ids: [w.zhou], parent_id: newId("space") }),
      ).rejects.toThrow(/no space/);
      await expect(w.directory.createSpace(newId("tenant"), { name: "X", owner_ids: [w.zhou] })).rejects.toThrow(
        /no tenant/,
      );
      const parent = await w.space("Finance");
      const child = await w.directory.createSpace(w.tenant, {
        name: "Budget",
        owner_ids: [w.zhou],
        parent_id: parent.id,
      });
      expect(child.space.parent_id).toBe(parent.id);
    });

    test.skipIf(skip)("change owners, name and description", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      const owned = await w.directory.putOwners(space.id, [w.lina, w.admin]);
      expect(owned.space).toMatchObject({ owner_id: w.lina, owner_ids: [w.lina, w.admin] });
      expect(await w.role(w.zhou, space.id)).toBeUndefined();
      expect(await w.role(w.admin, space.id)).toBe("owner");
      const renamed = await w.directory.patchSpace(space.id, { name: "Finance and tax", description: "Both" });
      expect(renamed.space).toMatchObject({
        name: "Finance and tax",
        description: "Both",
        owner_ids: [w.lina, w.admin],
      });
      await expect(w.directory.putOwners(newId("space"), [w.zhou])).rejects.toThrow(/no space/);
    });
  });

  describe("audiences", () => {
    test.skipIf(skip)("grant the whole tenant or members, and list the owners first", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      expect(await w.reads(w.lina, space.id)).toBe(false);
      const written = await w.directory.putAudience(space.id, [
        { principal_id: w.lina, role: "viewer" },
        { principal_id: "tenant", role: "commenter" },
        { principal_id: w.admin, role: "editor" },
      ]);
      expect(written.grants).toEqual([
        { principal_id: w.zhou, role: "owner" },
        { principal_id: w.admin, role: "editor" },
        { principal_id: "tenant", role: "commenter" },
        { principal_id: w.lina, role: "viewer" },
      ]);
      expect(written.consistency_token).toBeDefined();
      expect(await w.role(w.lina, space.id)).toBe("commenter");
      expect(await w.role(w.admin, space.id)).toBe("editor");
    });

    test.skipIf(skip)("are replaced whole, and owner grants sent back stay as they are", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      await w.directory.putAudience(space.id, [{ principal_id: w.lina, role: "editor" }]);
      const { grants } = (await w.directory.audience(space.id)) ?? { grants: [] };
      await w.directory.putAudience(space.id, [
        ...grants.filter((g) => g.role === "owner"),
        { principal_id: w.admin, role: "viewer" },
      ]);
      expect(await w.role(w.lina, space.id)).toBeUndefined();
      expect(await w.role(w.admin, space.id)).toBe("viewer");
      expect(await w.role(w.zhou, space.id)).toBe("owner");
    });

    test.skipIf(skip)("refuse owners they do not have, roles the tenant cannot hold, and doubles", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      await expect(w.directory.putAudience(space.id, [{ principal_id: w.lina, role: "owner" }])).rejects.toThrow(
        /not an owner/,
      );
      await expect(w.directory.putAudience(space.id, [{ principal_id: "tenant", role: "editor" }])).rejects.toThrow(
        /only view or comment/,
      );
      await expect(
        w.directory.putAudience(space.id, [
          { principal_id: w.lina, role: "viewer" },
          { principal_id: w.lina, role: "editor" },
        ]),
      ).rejects.toThrow(/more than one role/);
      await expect(
        w.directory.putAudience(space.id, [{ principal_id: newId("member"), role: "viewer" }]),
      ).rejects.toThrow(/not an invited or active member/);
    });

    test.skipIf(skip)("bring the graph in line with the records, leaving group grants alone", async ({ w }) => {
      const space = await w.space("Finance", [w.zhou]);
      const group = newId("group");
      await w.authz.grantSpace(space.id, "editor", w.lina); // granted around the directory
      await w.authz.grantSpace(space.id, "viewer", group);
      await w.directory.putAudience(space.id, [{ principal_id: w.admin, role: "viewer" }]);
      expect(await w.role(w.lina, space.id)).toBeUndefined();
      const groupGrants = await w.authz.graph.read("space", space.id, "viewer");
      expect(groupGrants.map((r) => r.subject.type).sort()).toEqual(["group", "member"]);
    });
  });
});
