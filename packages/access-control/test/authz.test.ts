// Access control contract tests, run against the in-memory evaluator and a real SpiceDB.

import {
  type AclEntry,
  type AclPrincipalKind,
  type AclRole,
  type AclSnapshot,
  contentHash,
  type IdKind,
  newEvent,
  newId,
  type Permission,
  type Principal,
  type ResourceRef,
} from "@inspiration/contracts";
import { InMemoryBus } from "@inspiration/eventbus";
import { MemoryStore } from "@inspiration/knowledge-store";
import { Sample } from "@inspiration/knowledge-store/testing";
import { hasStack, SPICEDB_ENDPOINT, SPICEDB_KEY } from "@inspiration/testkit";
import { describe, expect, test as unitTest } from "vitest";
import {
  AuthzService,
  aclChangedHandler,
  aclTokens,
  closeClient,
  connect,
  documentObjectId,
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

function acl(sourceId: string, externalId: string, entries: AclEntry[] = [], parent?: string): AclSnapshot {
  return {
    source_id: sourceId,
    external_id: externalId,
    fidelity: "exact",
    entries,
    ...(parent && { inherits_from_external_id: parent }),
    captured_at: new Date().toISOString(),
    acl_hash: contentHash(JSON.stringify(entries)),
  };
}

function entry(kind: AclPrincipalKind, principalId?: string, role: AclRole = "viewer"): AclEntry {
  return { principal_kind: kind, ...(principalId && { principal_id: principalId }), external_id: "ext", role };
}

const NAMES = {
  alice: "user",
  bob: "user",
  carol: "user",
  dave: "user",
  svc: "service",
  finance: "group",
  managers: "group",
  company: "department",
  sales: "department",
} as const satisfies Record<string, IdKind>;
type Name = keyof typeof NAMES;

/**
 * alice: finance (nested in managers). bob: sales (a sub-department of the company).
 * carol: confidential clearance. dave: not in the tenant. svc: pipeline service.
 */
class World {
  readonly ids = Object.fromEntries(Object.entries(NAMES).map(([n, kind]) => [n, newId(kind)])) as Record<Name, string>;
  readonly tenant = newId("tenant");
  readonly space = newId("space");
  readonly financeSpace = newId("space");
  readonly source = newId("source");
  readonly kb = new Sample({ tenantId: this.tenant, spaceId: this.space, sourceId: this.source });
  readonly store = new MemoryStore();
  readonly authz: AuthzService;

  constructor(graph: Graph) {
    this.authz = new AuthzService(graph, this.store);
  }

  async build(): Promise<this> {
    const { authz, ids, tenant, space, financeSpace, source } = this;
    for (const user of ["alice", "bob", "carol"] as const) await authz.addTenantMember(tenant, ids[user]);
    await authz.addService(tenant, ids.svc);
    await authz.grantClearance(tenant, ids.carol, "confidential");
    await authz.addMember(ids.finance, ids.alice);
    await authz.addMember(ids.managers, ids.finance);
    await authz.addMember(ids.sales, ids.bob);
    await authz.addMember(ids.company, ids.sales);

    await authz.createSpace(space, { tenantId: tenant, ownerId: ids.alice });
    await authz.grantSpace(space, "viewer", tenant);
    await authz.grantSpace(space, "editor", ids.bob);
    await authz.createSpace(financeSpace, { tenantId: tenant, ownerId: ids.alice });
    await authz.grantSpace(financeSpace, "viewer", ids.finance);
    await authz.registerSource(source, space);

    const mirror = (snapshot: AclSnapshot) => authz.mirror(snapshot, { spaceId: space });
    await mirror(acl(source, "doc-managers", [entry("group", ids.managers), entry("user", ids.bob)]));
    await mirror(acl(source, "doc-all", [entry("anyone_in_tenant")]));
    await mirror(
      acl(source, "doc-company", [
        entry("department", ids.company, "commenter"),
        entry("user"), // unmapped: ignored
        entry("external"),
      ]),
    );
    await mirror(acl(source, "doc-link", [entry("anyone_with_link")]));
    await mirror(acl(source, "doc-public", [entry("public")]));
    return this;
  }

  who(name: Name): Principal {
    const kind = NAMES[name] === "service" ? "service" : "user";
    return { id: this.ids[name], kind, tenant_id: this.tenant };
  }

  agent(forName: Name, fields: Partial<Principal> = {}): Principal {
    return { id: newId("agent"), kind: "agent", tenant_id: this.tenant, on_behalf_of: this.ids[forName], ...fields };
  }

  async can(who: Name | Principal, perm: Permission, res: ResourceRef): Promise<boolean> {
    return (await this.authz.check(typeof who === "string" ? this.who(who) : who, perm, res)).allow;
  }

  doc(externalId: string): ResourceRef {
    return documentRef(this.source, externalId);
  }

  /**
   * Claims backed by doc-managers, doc-all, both doc-managers and doc-company, and one
   * derived from the first two.
   */
  async claims(): Promise<Record<string, string>> {
    const { kb, store } = this;
    const out: Record<string, string> = {};
    const spans: Record<string, Parameters<Sample["claim"]>[1]> = {};
    for (const ext of ["doc-managers", "doc-all", "doc-company"]) {
      const [sv, [span]] = kb.sourceVersion([`${ext}: 住宿标准每晚600元。`], { external_id: ext });
      spans[ext] = span;
      out[`sv:${ext}`] = sv.id;
      await store.transaction((tx) => tx.putSourceVersion(sv, [span]));
    }
    const backing = { mgr: ["doc-managers"], all: ["doc-all"], mixed: ["doc-managers", "doc-company"] };
    for (const [name, exts] of Object.entries(backing)) {
      const [claim] = kb.claim(`claim ${name}`);
      const evidence = exts
        .flatMap((ext) => kb.claim(claim.statement, spans[ext])[1])
        .map((e) => ({
          ...e,
          claim_id: claim.id,
        }));
      await store.transaction((tx) => tx.upsertClaims([claim], evidence));
      out[name] = claim.id;
    }
    const [derived] = kb.claim("derived");
    await store.transaction((tx) =>
      tx.upsertClaims(
        [derived],
        [],
        [{ claim_id: derived.id, from_claim_ids: [out.mgr as string, out.all as string], method: "merge" }],
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
    test("document ACLs follow the source", async ({ w }) => {
      expect(await w.can("alice", "read", w.doc("doc-managers"))).toBe(true); // finance is nested in managers
      expect(await w.can("bob", "read", w.doc("doc-managers"))).toBe(true);
      expect(await w.can("carol", "read", w.doc("doc-managers"))).toBe(false);
      expect(await w.can("carol", "read", w.doc("doc-all"))).toBe(true);
      expect(await w.can("dave", "read", w.doc("doc-all"))).toBe(false);
      expect(await w.can("bob", "read", w.doc("doc-company"))).toBe(true); // sales is part of the company
      expect(await w.can("alice", "read", w.doc("doc-company"))).toBe(false);
      expect(await w.can("carol", "read", w.doc("doc-link"))).toBe(true);
      expect(await w.can("dave", "read", w.doc("doc-public"))).toBe(true);
      expect(await w.can("svc", "read", w.doc("doc-company"))).toBe(true); // services read everything in the tenant
      const edit = await w.authz.check(w.who("alice"), "edit", w.doc("doc-managers"));
      expect(edit.allow).toBe(false);
      expect(edit.reason).toMatch(/read-only/);
    });

    test("mirror replaces and forget removes", async ({ w }) => {
      const token = await w.authz.mirror(acl(w.source, "doc-managers", [entry("group", w.ids.managers)]), {
        spaceId: w.space,
      });
      expect(token).toEqual(expect.any(String));
      expect(await w.can("bob", "read", w.doc("doc-managers"))).toBe(false);
      expect(await w.can("alice", "read", w.doc("doc-managers"))).toBe(true);
      const decision = await w.authz.check(w.who("alice"), "read", w.doc("doc-managers"));
      expect(decision.consistency_token).toBe(token);
      await w.authz.forget(w.source, "doc-managers");
      expect(await w.can("alice", "read", w.doc("doc-managers"))).toBe(false);
      expect(await w.authz.graph.read("document", documentObjectId(w.source, "doc-managers"))).toEqual([]);
    });

    test("documents inherit their folder's ACL", async ({ w }) => {
      await w.authz.mirror(acl(w.source, "folder", [entry("user", w.ids.carol)]), { spaceId: w.space });
      await w.authz.mirror(acl(w.source, "folder/report.docx", [], "folder"), { spaceId: w.space });
      expect(await w.can("carol", "read", w.doc("folder/report.docx"))).toBe(true);
      expect(await w.can("bob", "read", w.doc("folder/report.docx"))).toBe(false);
    });

    test("mirroring into an unknown space fails", async ({ w }) => {
      await expect(w.authz.mirror(acl(w.source, "x"), { spaceId: newId("space") })).rejects.toThrow(/not registered/);
    });
  });

  describe.skipIf(skip)("spaces", () => {
    test("space roles", async ({ w }) => {
      const space: ResourceRef = { type: "space", id: w.space };
      const finance: ResourceRef = { type: "space", id: w.financeSpace };
      expect(await w.can("carol", "read", space)).toBe(true);
      expect(await w.can("carol", "comment", space)).toBe(false);
      expect(await w.can("bob", "comment", space)).toBe(true); // editor implies comment
      expect(await w.can("bob", "verify", space)).toBe(false);
      expect(await w.can("alice", "admin", space)).toBe(true);
      expect(await w.can("alice", "publish", space)).toBe(true);
      expect(await w.can("dave", "discover", space)).toBe(false);
      expect(await w.can("alice", "read", finance)).toBe(true);
      expect(await w.can("bob", "read", finance)).toBe(false);
      const tenant: ResourceRef = { type: "tenant", id: w.tenant };
      expect(await w.can("bob", "read", tenant)).toBe(true);
      expect(await w.can("bob", "admin", tenant)).toBe(false);
      expect(await w.can("bob", "read", { type: "tenant", id: newId("tenant") })).toBe(false);
    });
  });

  describe.skipIf(skip)("derived knowledge", () => {
    test("claims are readable only through readable sources", async ({ w }) => {
      const c = await w.claims();
      const claim = (name: string): ResourceRef => ({ type: "claim", id: c[name] as string });
      expect(await w.can("alice", "read", claim("mgr"))).toBe(true);
      expect(await w.can("carol", "read", claim("mgr"))).toBe(false);
      expect(await w.can("carol", "read", claim("all"))).toBe(true);
      expect(await w.can("dave", "read", claim("all"))).toBe(false); // not in the space either

      for (const [name, docs] of [
        ["alice", ["doc-managers"]],
        ["bob", ["doc-company", "doc-managers"]],
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

      const decisions = await w.authz.checkMany(w.who("carol"), "read", [claim("mgr"), claim("all")]);
      expect(decisions.map((d) => d.allow)).toEqual([false, true]);
    });
  });

  describe.skipIf(skip)("contradicting evidence", () => {
    test("only supporting evidence makes a claim readable", async ({ w }) => {
      const { kb, store } = w;
      const [managers, [secret]] = kb.sourceVersion(["差旅：一线城市住宿每晚不超过600元。"], {
        external_id: "doc-managers",
      });
      const [all, [open]] = kb.sourceVersion(["差旅：一线城市住宿每晚不超过650元。"], { external_id: "doc-all" });
      await store.transaction(async (tx) => {
        await tx.putSourceVersion(managers, [secret]);
        await tx.putSourceVersion(all, [open]);
      });
      const [claim, evidence] = kb.claim("一线城市住宿上限为每晚600元", secret);
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
        readable_support: [managers.id],
      });

      // A claim derived from it inherits only its support.
      const [derived] = kb.claim("一线城市住宿有上限");
      await store.transaction((tx) =>
        tx.upsertClaims([derived], [], [{ claim_id: derived.id, from_claim_ids: [claim.id], method: "infer" }]),
      );
      expect(await w.authz.canReadDerived(w.who("carol"), derived.id)).toEqual({ allow: false, readable_support: [] });
    });
  });

  describe.skipIf(skip)("agents", () => {
    test("agents act with the person's rights, cut to their scope", async ({ w }) => {
      const space: ResourceRef = { type: "space", id: w.space };
      expect(await w.can(w.agent("bob"), "read", space)).toBe(true);
      expect(await w.can(w.agent("bob"), "comment", space)).toBe(false); // read-only by default
      expect(await w.can(w.agent("bob", { agent_scopes: ["read", "comment"] }), "comment", space)).toBe(true);
      expect(await w.can(w.agent("carol", { agent_scopes: ["comment"] }), "comment", space)).toBe(false);
      expect(await w.can(w.agent("bob", { space_scope: [w.financeSpace] }), "read", space)).toBe(false);
      expect(await w.can(w.agent("carol"), "read", w.doc("doc-managers"))).toBe(false);
      const orphan: Principal = { id: newId("agent"), kind: "agent", tenant_id: w.tenant };
      await expect(w.authz.check(orphan, "read", space)).rejects.toThrow(PrincipalError);
    });
  });

  describe.skipIf(skip)("index pre-filter", () => {
    test("the scope filter matches chunk tokens", async ({ w }) => {
      const alice = await w.authz.scopeFilter(w.who("alice"), "read");
      expect([...alice.space_ids].sort()).toEqual([w.space, w.financeSpace].sort());
      expect(alice.principal_tokens).toEqual(
        expect.arrayContaining([w.ids.alice, w.ids.finance, w.ids.managers, `tenant:${w.tenant}`]),
      );
      expect(alice.max_sensitivity).toBe("internal");
      const bob = await w.authz.scopeFilter(w.who("bob"), "read");
      expect(bob.principal_tokens).toEqual(expect.arrayContaining([w.ids.sales, w.ids.company]));
      const carol = await w.authz.scopeFilter(w.who("carol"), "read");
      expect(carol.max_sensitivity).toBe("confidential");
      const dave = await w.authz.scopeFilter(w.who("dave"), "read");
      expect(dave.space_ids).toEqual([]);
      expect(dave.max_sensitivity).toBe("public");

      const tokens = aclTokens(acl(w.source, "doc-managers", [entry("group", w.ids.managers)]), w.tenant);
      expect(tokens).toEqual([w.ids.managers, `system:${w.tenant}`].sort());
      expect(tokens.some((t) => alice.principal_tokens.includes(t))).toBe(true);
      expect(tokens.some((t) => carol.principal_tokens.includes(t))).toBe(false);

      const svc = await w.authz.scopeFilter(w.who("svc"), "read");
      expect(svc.principal_tokens).toEqual([`system:${w.tenant}`]);
      expect(svc.max_sensitivity).toBe("secret");
      expect(svc.space_ids).toContain(w.space);

      const agent = await w.authz.scopeFilter(w.agent("alice", { space_scope: [w.space] }), "read");
      expect(agent.space_ids).toEqual([w.space]);
      const blocked = await w.authz.scopeFilter(w.agent("alice"), "edit");
      expect(blocked).toEqual({ space_ids: [], principal_tokens: [], max_sensitivity: "public" });
    });
  });

  describe.skipIf(skip)("events", () => {
    test("acl.changed events are mirrored", async ({ w }) => {
      const bus = new InMemoryBus();
      bus.subscribe("acl.changed", "access-control", aclChangedHandler(w.authz));
      const publish = (payload: Parameters<typeof newEvent<"acl.changed">>[1]) =>
        bus.publish(newEvent("acl.changed", payload, { tenantId: w.tenant, producer: "source-sync" }));
      const snapshot = acl(w.source, "doc-new", [entry("user", w.ids.carol)]);
      const changed = {
        source_id: w.source,
        external_id: "doc-new",
        space_id: w.space,
        acl_hash: snapshot.acl_hash,
        fidelity: snapshot.fidelity,
      };
      await publish({ ...changed, snapshot });
      // A large ACL travels through the store instead of the event.
      const stored = acl(w.source, "doc-stored", [entry("user", w.ids.dave)]);
      await w.store.transaction((tx) => tx.putAclSnapshot(stored));
      await publish({ ...changed, external_id: "doc-stored", acl_hash: stored.acl_hash });
      await publish({ ...changed, external_id: "doc-unknown" });
      await bus.drain();
      expect(await w.can("carol", "read", w.doc("doc-new"))).toBe(true);
      expect(await w.can("dave", "read", w.doc("doc-stored"))).toBe(true);
      const dead = bus.deadLetters("access-control");
      expect(dead.map((d) => (d.event?.data as { external_id: string } | undefined)?.external_id)).toEqual([
        "doc-unknown",
      ]);
    });
  });
});

unitTest("ACL tokens for open documents", () => {
  const tenant = newId("tenant");
  const snapshot = acl(newId("source"), "x", [
    entry("anyone_in_tenant"),
    entry("anyone_with_link"),
    entry("public"),
    entry("user"),
  ]);
  expect(aclTokens(snapshot, tenant)).toEqual(
    [`system:${tenant}`, `tenant:${tenant}`, `link:${tenant}`, "public"].sort(),
  );
});

unitTest("document IDs are valid SpiceDB IDs", () => {
  expect(documentObjectId("src_1", "folder/doc-1")).toBe("src_1|folder/doc-1");
  const odd = documentObjectId("src_1", "报告 2026.docx");
  expect(odd).toMatch(/^src_1\|=[A-Za-z0-9_-]+$/);
  expect(documentObjectId("src_1", "=x")).not.toBe("src_1|=x");
});

unitTest("the in-memory graph rejects relationships the schema forbids", async () => {
  const g = new MemoryGraph();
  await expect(g.write({ touch: [rel(obj("group", "grp_x"), "member", subject("tenant", "ten_x"))] })).rejects.toThrow(
    GraphError,
  );
  await expect(g.write({ touch: [rel(obj("space", "spc_x"), "approver", subject("user", "usr_x"))] })).rejects.toThrow(
    /no relation/,
  );
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
        graph.write({ touch: [rel(obj("space", newId("space")), "approver", subject("user", newId("user")))] }),
      ).rejects.toThrow(GraphError);
    } finally {
      closeClient(client);
    }
  });
});
