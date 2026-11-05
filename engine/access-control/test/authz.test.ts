// Access control contract tests, run against the in-memory evaluator and a real SpiceDB.

import {
  type AclSnapshot,
  contentHash,
  type IdKind,
  newId,
  type Permission,
  type Principal,
  type ResourceRef,
} from "@inspiration/contracts";
import { MemoryStore } from "@inspiration/knowledge-store";
import { Sample } from "@inspiration/knowledge-store/testing";
import { hasStack, SPICEDB_ENDPOINT, SPICEDB_KEY } from "@inspiration/testkit";
import { describe, expect, test as unitTest } from "vitest";
import {
  AuthzService,
  chunkTokens,
  closeClient,
  connect,
  documentRef,
  type Graph,
  GraphError,
  MemoryGraph,
  obj,
  PrincipalError,
  rel,
  SpiceDBGraph,
  subject,
  writeSchema,
} from "../src/index.ts";

type Backend = "memory" | "spicedb";
const BACKENDS: { backend: Backend; skip: boolean }[] = [
  { backend: "memory", skip: false },
  { backend: "spicedb", skip: !hasStack() },
];

const NAMES = {
  alice: "member",
  bob: "member",
  carol: "member",
  dave: "member",
  erin: "member",
  svc: "service",
  finance: "group",
  managers: "group",
  company: "department",
  sales: "department",
} as const satisfies Record<string, IdKind>;
type Name = keyof typeof NAMES;

/**
 * alice: finance (nested in managers), owns the company and finance spaces. bob: sales (a
 * sub-department of the company), edits the company space and owns the sales space. carol:
 * confidential clearance. dave: not in the tenant. erin: the tenant's admin, in no audience
 * but the company's. svc: pipeline service.
 *
 * Spaces and their sources: company (everyone in the tenant reads it) with doc-all; finance
 * (the finance group reads it) with doc-finance, and below it budget, which grants nothing of
 * its own, with doc-budget; sales (the company department reads it) with doc-sales.
 */
class World {
  readonly ids = Object.fromEntries(Object.entries(NAMES).map(([n, kind]) => [n, newId(kind)])) as Record<Name, string>;
  readonly tenant = newId("tenant");
  readonly space = newId("space");
  readonly financeSpace = newId("space");
  readonly budgetSpace = newId("space");
  readonly salesSpace = newId("space");
  readonly source = newId("source");
  readonly financeSource = newId("source");
  readonly budgetSource = newId("source");
  readonly salesSource = newId("source");
  readonly kb = new Sample({ tenantId: this.tenant, spaceId: this.space, sourceId: this.source });
  readonly store = new MemoryStore();
  readonly authz: AuthzService;

  constructor(graph: Graph) {
    this.authz = new AuthzService(graph, this.store);
  }

  async build(): Promise<this> {
    const { authz, ids, tenant } = this;
    for (const user of ["alice", "bob", "carol", "erin"] as const) await authz.addTenantMember(tenant, ids[user]);
    await authz.addTenantAdmin(tenant, ids.erin);
    await authz.addService(tenant, ids.svc);
    await authz.grantClearance(tenant, ids.carol, "confidential");
    await authz.addMember(tenant, ids.finance, ids.alice);
    await authz.addMember(tenant, ids.managers, ids.finance);
    await authz.addMember(tenant, ids.sales, ids.bob);
    await authz.addMember(tenant, ids.company, ids.sales);

    await authz.createSpace(this.space, { tenantId: tenant, ownerId: ids.alice });
    await authz.grantSpace(this.space, "viewer", tenant);
    await authz.grantSpace(this.space, "editor", ids.bob);
    await authz.createSpace(this.financeSpace, { tenantId: tenant, ownerId: ids.alice });
    await authz.grantSpace(this.financeSpace, "viewer", ids.finance);
    await authz.createSpace(this.budgetSpace, { tenantId: tenant, ownerId: ids.alice, parentId: this.financeSpace });
    await authz.createSpace(this.salesSpace, { tenantId: tenant, ownerId: ids.bob });
    await authz.grantSpace(this.salesSpace, "viewer", ids.company);
    await authz.registerSource(this.source, this.space);
    await authz.registerSource(this.financeSource, this.financeSpace);
    await authz.registerSource(this.budgetSource, this.budgetSpace);
    await authz.registerSource(this.salesSource, this.salesSpace);
    return this;
  }

  who(name: Name): Principal {
    const kind = NAMES[name] === "service" ? "service" : "member";
    return { id: this.ids[name], kind, tenant_id: this.tenant };
  }

  agent(forName: Name, fields: Partial<Principal> = {}): Principal {
    return { id: newId("agent"), kind: "agent", tenant_id: this.tenant, on_behalf_of: this.ids[forName], ...fields };
  }

  async can(who: Name | Principal, perm: Permission, res: ResourceRef): Promise<boolean> {
    return (await this.authz.check(typeof who === "string" ? this.who(who) : who, perm, res)).allow;
  }

  /** The source each test document comes from. */
  sourceOf(externalId: string): string {
    const source = {
      "doc-all": this.source,
      "doc-finance": this.financeSource,
      "doc-budget": this.budgetSource,
      "doc-sales": this.salesSource,
    }[externalId];
    if (!source) throw new RangeError(`no document ${externalId}`);
    return source;
  }

  doc(externalId: string): ResourceRef {
    return documentRef(this.sourceOf(externalId), externalId);
  }

  spaceRef(id: string): ResourceRef {
    return { type: "space", id };
  }

  /**
   * Claims backed by doc-finance, doc-all, both doc-finance and doc-sales, and one derived
   * from the first two. Every claim sits in the company space; its sources decide.
   */
  async claims(): Promise<Record<string, string>> {
    const { kb, store } = this;
    const out: Record<string, string> = {};
    const spans: Record<string, Parameters<Sample["claim"]>[1]> = {};
    for (const ext of ["doc-finance", "doc-all", "doc-sales"]) {
      const [sv, [span]] = kb.sourceVersion([`${ext}: hotels at most 600 yuan a night.`], {
        external_id: ext,
        source_id: this.sourceOf(ext),
      });
      spans[ext] = span;
      out[`sv:${ext}`] = sv.id;
      await store.transaction((tx) => tx.putSourceVersion(sv, [span]));
    }
    const backing = { fin: ["doc-finance"], all: ["doc-all"], mixed: ["doc-finance", "doc-sales"] };
    for (const [name, exts] of Object.entries(backing)) {
      const [claim] = kb.claim(`claim ${name}`);
      const evidence = exts
        .flatMap((ext) => kb.claim(claim.statement, spans[ext])[1])
        .map((e) => ({ ...e, claim_id: claim.id }));
      await store.transaction((tx) => tx.upsertClaims([claim], evidence));
      out[name] = claim.id;
    }
    const [derived] = kb.claim("derived");
    await store.transaction((tx) =>
      tx.upsertClaims(
        [derived],
        [],
        [{ claim_id: derived.id, from_claim_ids: [out.fin as string, out.all as string], method: "merge" }],
      ),
    );
    out.derived = derived.id;
    return out;
  }
}

let schemaWritten: Promise<string> | undefined;

function authzTest(backend: Backend) {
  return (
    unitTest
      // biome-ignore lint/correctness/noEmptyPattern: Vitest reads fixture dependencies from this pattern
      .extend("graph", async ({}, { onCleanup }): Promise<Graph> => {
        if (backend === "memory") return new MemoryGraph();
        // Every test uses fresh IDs, so SpiceDB tests share one instance without clearing it.
        const client = connect(SPICEDB_ENDPOINT, SPICEDB_KEY, { insecure: true });
        onCleanup(() => closeClient(client));
        schemaWritten ??= writeSchema(client);
        await schemaWritten;
        return new SpiceDBGraph(client);
      })
      .extend("w", async ({ graph }) => new World(graph).build())
  );
}

describe.each(BACKENDS)("$backend graph", ({ backend, skip }) => {
  const test = authzTest(backend);

  describe.skipIf(skip)("documents", () => {
    test("are readable by whoever may read their space", async ({ w }) => {
      expect(await w.can("alice", "read", w.doc("doc-finance"))).toBe(true); // through the finance group
      expect(await w.can("bob", "read", w.doc("doc-finance"))).toBe(false);
      expect(await w.can("carol", "read", w.doc("doc-all"))).toBe(true); // everyone in the tenant
      expect(await w.can("dave", "read", w.doc("doc-all"))).toBe(false);
      expect(await w.can("bob", "read", w.doc("doc-sales"))).toBe(true); // sales is part of the company
      expect(await w.can("alice", "read", w.doc("doc-sales"))).toBe(false);
      expect(await w.can("alice", "read", w.doc("doc-budget"))).toBe(true); // from the space above
      expect(await w.can("svc", "read", w.doc("doc-sales"))).toBe(true); // services read everything in the tenant
      expect(await w.can("alice", "read", documentRef(newId("source"), "doc-1"))).toBe(false);
      const edit = await w.authz.check(w.who("alice"), "edit", w.doc("doc-finance"));
      expect(edit.allow).toBe(false);
      expect(edit.reason).toMatch(/read-only/);
    });

    test("ignore the ACL their source reports", async ({ w }) => {
      // Source-sync keeps the snapshot as advisory; here it names only bob.
      const snapshot: AclSnapshot = {
        source_id: w.source,
        external_id: "doc-all",
        fidelity: "exact",
        entries: [{ principal_kind: "user", principal_id: w.ids.bob, external_id: "bob", role: "viewer" }],
        captured_at: new Date().toISOString(),
        acl_hash: contentHash("bob"),
      };
      await w.store.transaction((tx) => tx.putAclSnapshot(snapshot));
      expect(await w.can("carol", "read", w.doc("doc-all"))).toBe(true);
    });

    test("carry the consistency token of the last write", async ({ w }) => {
      const token = await w.authz.grantSpace(w.salesSpace, "viewer", w.ids.carol);
      expect(token).toEqual(expect.any(String));
      const decision = await w.authz.check(w.who("carol"), "read", w.doc("doc-sales"));
      expect(decision).toMatchObject({ allow: true, consistency_token: token });
      await w.authz.revokeSpace(w.salesSpace, "viewer", w.ids.carol);
      expect(await w.can("carol", "read", w.doc("doc-sales"))).toBe(false);
    });
  });

  describe.skipIf(skip)("spaces", () => {
    test("space roles", async ({ w }) => {
      const space = w.spaceRef(w.space);
      expect(await w.can("carol", "read", space)).toBe(true);
      expect(await w.can("carol", "comment", space)).toBe(false);
      expect(await w.can("bob", "comment", space)).toBe(true); // editor implies comment
      expect(await w.can("bob", "verify", space)).toBe(false);
      expect(await w.can("alice", "admin", space)).toBe(true);
      expect(await w.can("alice", "publish", space)).toBe(true);
      expect(await w.can("dave", "discover", space)).toBe(false);
      expect(await w.can("alice", "read", w.spaceRef(w.financeSpace))).toBe(true);
      expect(await w.can("bob", "read", w.spaceRef(w.financeSpace))).toBe(false);
      const tenant: ResourceRef = { type: "tenant", id: w.tenant };
      expect(await w.can("bob", "read", tenant)).toBe(true);
      expect(await w.can("bob", "admin", tenant)).toBe(false);
      expect(await w.can("bob", "read", { type: "tenant", id: newId("tenant") })).toBe(false);
    });

    test("hold in every space below", async ({ w }) => {
      const budget = w.spaceRef(w.budgetSpace);
      expect(await w.can("alice", "admin", budget)).toBe(true); // she owns the finance space above
      expect(await w.can("alice", "verify", budget)).toBe(true);
      expect(await w.can("bob", "read", budget)).toBe(false);
      await w.authz.grantSpace(w.financeSpace, "steward", w.ids.bob);
      expect(await w.can("bob", "verify", budget)).toBe(true);
      expect(await w.can("bob", "admin", budget)).toBe(false);
    });

    test("the tenant's admin manages every space and reads only those whose audience includes them", async ({ w }) => {
      const all = [w.space, w.financeSpace, w.budgetSpace, w.salesSpace];
      for (const id of all) expect(await w.can("erin", "admin", w.spaceRef(id))).toBe(true);
      expect(await w.can("erin", "admin", { type: "tenant", id: w.tenant })).toBe(true);
      expect(await w.can("erin", "read", w.spaceRef(w.space))).toBe(true); // everyone in the tenant reads it
      for (const id of [w.financeSpace, w.budgetSpace, w.salesSpace]) {
        expect(await w.can("erin", "read", w.spaceRef(id))).toBe(false);
        expect(await w.can("erin", "verify", w.spaceRef(id))).toBe(false);
      }
      expect(await w.can("erin", "read", w.doc("doc-finance"))).toBe(false);
      expect((await w.authz.scopeFilter(w.who("erin"), "read")).space_ids).toEqual([w.space]);
      expect([...(await w.authz.scopeFilter(w.who("erin"), "admin")).space_ids].sort()).toEqual([...all].sort());
    });

    test("say each member's highest role and who owns them", async ({ w }) => {
      const all = [w.space, w.financeSpace, w.budgetSpace, w.salesSpace];
      expect(await w.authz.spaceRoles(w.who("alice"), all)).toEqual(["owner", "owner", "owner", undefined]);
      expect(await w.authz.spaceRoles(w.who("bob"), all)).toEqual(["editor", undefined, undefined, "owner"]);
      expect(await w.authz.spaceRoles(w.who("carol"), all)).toEqual(["viewer", undefined, undefined, undefined]);
      expect(await w.authz.spaceRoles(w.who("erin"), all)).toEqual(["viewer", undefined, undefined, undefined]);
      expect(await w.authz.spaceRoles(w.who("dave"), all)).toEqual([undefined, undefined, undefined, undefined]);
      expect(await w.authz.spaceOwners(w.space)).toEqual([w.ids.alice]);
      await w.authz.grantSpace(w.space, "owner", w.ids.carol);
      expect(await w.authz.spaceOwners(w.space)).toEqual([w.ids.alice, w.ids.carol].sort());
      expect(await w.authz.spaceOwners(w.budgetSpace)).toEqual([w.ids.alice]);
    });
  });

  describe.skipIf(skip)("derived knowledge", () => {
    test("claims are readable only through sources in readable spaces", async ({ w }) => {
      const c = await w.claims();
      const claim = (name: string): ResourceRef => ({ type: "claim", id: c[name] as string });
      expect(await w.can("alice", "read", claim("fin"))).toBe(true);
      expect(await w.can("carol", "read", claim("fin"))).toBe(false);
      expect(await w.can("carol", "read", claim("all"))).toBe(true);
      expect(await w.can("dave", "read", claim("all"))).toBe(false); // not in the space either

      for (const [name, docs] of [
        ["alice", ["doc-finance"]],
        ["bob", ["doc-sales"]],
      ] as const) {
        const decision = await w.authz.canReadDerived(w.who(name), c.mixed as string);
        expect(decision.allow).toBe(true);
        expect(decision.readable_support).toEqual(docs.map((d) => c[`sv:${d}`]).sort());
      }
      // Nothing named, nothing counted.
      expect(await w.authz.canReadDerived(w.who("carol"), c.mixed as string)).toEqual({
        allow: false,
        readable_support: [],
      });

      expect(await w.authz.canReadDerived(w.who("carol"), c.derived as string)).toEqual({
        allow: true,
        readable_support: [c["sv:doc-all"]],
      });
      expect(await w.can("carol", "read", claim("derived"))).toBe(true);
      expect(await w.can("carol", "comment", claim("all"))).toBe(false); // a space viewer cannot comment

      const decisions = await w.authz.checkMany(w.who("carol"), "read", [claim("fin"), claim("all")]);
      expect(decisions.map((d) => d.allow)).toEqual([false, true]);
    });
  });

  describe.skipIf(skip)("contradicting evidence", () => {
    test("only supporting evidence makes a claim readable", async ({ w }) => {
      const { kb, store } = w;
      const [finance, [secret]] = kb.sourceVersion(["Travel: hotels in tier-1 cities at most 600 yuan a night."], {
        external_id: "doc-finance",
        source_id: w.financeSource,
      });
      const [all, [open]] = kb.sourceVersion(["Travel: hotels in tier-1 cities at most 650 yuan a night."], {
        external_id: "doc-all",
      });
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(finance, [secret]);
        await tx.putSourceVersion(all, [open]);
      });
      const [claim, evidence] = kb.claim("The tier-1 city hotel cap is 600 yuan a night", secret);
      await store.transaction((tx) => tx.upsertClaims([claim], evidence));
      const before = await w.authz.canReadDerived(w.who("carol"), claim.id);
      expect(before).toEqual({ allow: false, readable_support: [] });

      // carol can read doc-all, which now contradicts the claim and, in a second span role, qualifies it.
      const against = kb.claim(claim.statement, open)[1].flatMap((e) => [
        { ...e, claim_id: claim.id, role: "contradicts" as const },
        { ...e, claim_id: claim.id, role: "qualifies" as const },
      ]);
      await store.transaction((tx) => tx.upsertClaims([], against));
      const lineage = await store.lineage(claim.id);
      expect(lineage.edges.filter((e) => e.relation === "cites").map((e) => e.role)).toEqual(
        expect.arrayContaining(["supports", "contradicts", "qualifies"]),
      );

      expect(await w.authz.canReadDerived(w.who("carol"), claim.id)).toEqual({ allow: false, readable_support: [] });
      expect(await w.can("carol", "read", { type: "claim", id: claim.id })).toBe(false);
      expect(await w.authz.canReadDerived(w.who("alice"), claim.id)).toEqual({
        allow: true,
        readable_support: [finance.id],
      });

      // A claim derived from it inherits only its support.
      const [derived] = kb.claim("Tier-1 city hotels have a cap");
      await store.transaction((tx) =>
        tx.upsertClaims([derived], [], [{ claim_id: derived.id, from_claim_ids: [claim.id], method: "infer" }]),
      );
      expect(await w.authz.canReadDerived(w.who("carol"), derived.id)).toEqual({ allow: false, readable_support: [] });
    });
  });

  describe.skipIf(skip)("agents", () => {
    test("agents act with the person's rights, cut to their scope", async ({ w }) => {
      const space = w.spaceRef(w.space);
      expect(await w.can(w.agent("bob"), "read", space)).toBe(true);
      expect(await w.can(w.agent("bob"), "comment", space)).toBe(false); // read-only by default
      expect(await w.can(w.agent("bob", { agent_scopes: ["read", "comment"] }), "comment", space)).toBe(true);
      expect(await w.can(w.agent("carol", { agent_scopes: ["comment"] }), "comment", space)).toBe(false);
      expect(await w.can(w.agent("bob", { space_scope: [w.financeSpace] }), "read", space)).toBe(false);
      expect(await w.can(w.agent("carol"), "read", w.doc("doc-finance"))).toBe(false);
      expect(await w.can(w.agent("alice", { space_scope: [w.space] }), "read", w.doc("doc-finance"))).toBe(false);
      const orphan: Principal = { id: newId("agent"), kind: "agent", tenant_id: w.tenant };
      await expect(w.authz.check(orphan, "read", space)).rejects.toThrow(PrincipalError);
      await expect(w.authz.check(w.agent("finance"), "read", space)).rejects.toThrow(PrincipalError);
    });
  });

  describe.skipIf(skip)("tenants", () => {
    test("the same principal ID in another tenant shares none of its rights", async ({ w }) => {
      // The business layer may give a person the same member ID in every tenant they join.
      const other = newId("tenant");
      const otherSpace = w.spaceRef(newId("space"));
      const elsewhere = (name: Name): Principal => ({ ...w.who(name), tenant_id: other });
      for (const name of ["alice", "bob", "carol"] as const) await w.authz.addTenantMember(other, w.ids[name]);
      await w.authz.createSpace(otherSpace.id, { tenantId: other, ownerId: w.ids.bob });
      await w.authz.grantSpace(otherSpace.id, "viewer", w.ids.carol);
      await w.authz.addMember(other, w.ids.finance, w.ids.bob);

      expect(await w.can(elsewhere("alice"), "read", w.doc("doc-finance"))).toBe(false);
      expect(await w.can(elsewhere("alice"), "read", w.spaceRef(w.space))).toBe(false);
      expect(await w.can(elsewhere("bob"), "admin", otherSpace)).toBe(true);
      expect(await w.can("bob", "admin", otherSpace)).toBe(false);
      expect(await w.can("erin", "admin", otherSpace)).toBe(false); // an admin of the first tenant only
      expect(await w.can(elsewhere("carol"), "read", otherSpace)).toBe(true);
      expect(await w.can("carol", "read", otherSpace)).toBe(false);
      // The other tenant's group with the same ID is another group.
      expect(await w.can("bob", "read", w.spaceRef(w.financeSpace))).toBe(false);

      const filter = await w.authz.scopeFilter(elsewhere("alice"), "read");
      expect(filter.space_ids).toEqual([]);
      expect(filter.principal_tokens).toEqual([`tenant:${other}`]);

      // Removing a member in one tenant leaves the other alone.
      await w.authz.addMember(other, w.ids.finance, w.ids.alice);
      await w.authz.removeMember(other, w.ids.finance, w.ids.alice);
      expect(await w.can("alice", "read", w.spaceRef(w.financeSpace))).toBe(true);

      await expect(w.authz.grantSpace(otherSpace.id, "viewer", w.tenant)).rejects.toThrow(PrincipalError);
      await expect(
        w.authz.createSpace(newId("space"), { tenantId: other, ownerId: w.ids.bob, parentId: w.space }),
      ).rejects.toThrow(/another tenant/);
    });
  });

  describe.skipIf(skip)("index pre-filter", () => {
    test("the scope filter gives the readable spaces and matches the chunk tokens", async ({ w }) => {
      const alice = await w.authz.scopeFilter(w.who("alice"), "read");
      expect([...alice.space_ids].sort()).toEqual([w.space, w.financeSpace, w.budgetSpace].sort());
      expect(alice.principal_tokens).toEqual([`tenant:${w.tenant}`]);
      expect(alice.max_sensitivity).toBe("internal");
      const bob = await w.authz.scopeFilter(w.who("bob"), "read");
      expect([...bob.space_ids].sort()).toEqual([w.space, w.salesSpace].sort());
      const carol = await w.authz.scopeFilter(w.who("carol"), "read");
      expect(carol.max_sensitivity).toBe("confidential");
      const dave = await w.authz.scopeFilter(w.who("dave"), "read");
      expect(dave).toEqual({ space_ids: [], principal_tokens: [], max_sensitivity: "public" });

      const tokens = chunkTokens(w.tenant);
      expect(tokens).toEqual([`system:${w.tenant}`, `tenant:${w.tenant}`]);
      expect(tokens.some((t) => alice.principal_tokens.includes(t))).toBe(true);
      expect(chunkTokens(newId("tenant")).some((t) => alice.principal_tokens.includes(t))).toBe(false);

      const svc = await w.authz.scopeFilter(w.who("svc"), "read");
      expect(svc.principal_tokens).toEqual([`system:${w.tenant}`]);
      expect(svc.max_sensitivity).toBe("secret");
      expect([...svc.space_ids].sort()).toEqual([w.space, w.financeSpace, w.budgetSpace, w.salesSpace].sort());

      const agent = await w.authz.scopeFilter(w.agent("alice", { space_scope: [w.space] }), "read");
      expect(agent.space_ids).toEqual([w.space]);
      const blocked = await w.authz.scopeFilter(w.agent("alice"), "edit");
      expect(blocked).toEqual({ space_ids: [], principal_tokens: [], max_sensitivity: "public" });
    });
  });
});

unitTest("the in-memory graph rejects relationships the schema forbids", async () => {
  const g = new MemoryGraph();
  await expect(g.write({ touch: [rel(obj("group", "grp_x"), "member", subject("tenant", "ten_x"))] })).rejects.toThrow(
    GraphError,
  );
  await expect(
    g.write({ touch: [rel(obj("space", "spc_x"), "approver", subject("member", "ten_x|mem_x"))] }),
  ).rejects.toThrow(/no relation/);
  // Source ACLs are not permissions: there are no document objects to grant on.
  await expect(
    g.write({ touch: [rel(obj("document", "src_x|doc"), "viewer", subject("member", "ten_x|mem_x"))] }),
  ).rejects.toThrow(/no relation/);
  expect(() => new MemoryGraph("definition a { relation r: a\n permission p = r & r }")).toThrow(/only unions/);
});

describe.skipIf(!hasStack())("SpiceDB", () => {
  unitTest("schema violations become GraphErrors", async () => {
    const client = connect(SPICEDB_ENDPOINT, SPICEDB_KEY, { insecure: true });
    try {
      schemaWritten ??= writeSchema(client);
      await schemaWritten;
      const graph = new SpiceDBGraph(client);
      await expect(
        graph.write({ touch: [rel(obj("space", newId("space")), "approver", subject("member", newId("member")))] }),
      ).rejects.toThrow(GraphError);
    } finally {
      closeClient(client);
    }
  });
});
