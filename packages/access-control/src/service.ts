/**
 * The permission service: AuthZ and AclMirror over a relationship graph.
 *
 * Rules, in one place:
 *
 * - Source documents keep the ACL of the system they came from. Unmapped and external
 *   principals in a source ACL get nothing.
 * - Spaces hold Inspiration roles: viewer < commenter < editor < steward / owner.
 * - Derived knowledge (claims, pages, SOPs) is readable only through source documents the
 *   viewer can read now, found by walking lineage along support paths: supporting evidence,
 *   derivations and dependencies. Contradicting or qualifying evidence never makes a claim
 *   readable. Hidden support is never counted or named.
 * - An agent acts on behalf of a member: its rights are the member's, cut down to its
 *   agent_scopes (read and discover when absent) and its space_scope.
 * - Principal IDs are unique only within their tenant (a person may have the same member ID
 *   in every tenant they join). Members, services, groups and departments are therefore
 *   keyed by tenant in the graph, and a principal only ever gets rights in its own tenant.
 * - Search indexes get an IndexFilter (spaces, principal tokens, clearance) so ranking only
 *   ever sees rows the viewer may read; results are still re-checked before they leave.
 *
 * Every write returns the graph's consistency token (a SpiceDB ZedToken), which callers pass
 * on as consistency_token so a later read can ask for results at least that fresh.
 */

import type {
  AclMirror,
  AclRole,
  AclSnapshot,
  AuthZ,
  Decision,
  DerivedReadDecision,
  IndexFilter,
  KnowledgeStore,
  LineageGraph,
  Permission,
  Principal,
  ResourceRef,
  SensitivityLabel,
} from "@inspiration/contracts";
import { kindOf } from "@inspiration/contracts";
import {
  formatRelationship,
  type Graph,
  type ObjectRef,
  obj,
  type Relationship,
  rel,
  type SubjectRef,
  subject,
} from "./graph.ts";

const READ_ONLY: ReadonlySet<Permission> = new Set(["discover", "read"]);
/** How far canReadDerived walks lineage from a unit towards its source versions. */
export const LINEAGE_DEPTH = 6;
/** SpiceDB's object ID alphabet, without a leading "=". */
const SAFE_ID = /^[a-zA-Z0-9/_\-+][a-zA-Z0-9/_\-=+]{0,899}$/;
const DOCUMENT_ROLES: Readonly<Record<AclRole, string>> = {
  viewer: "viewer",
  commenter: "commenter",
  editor: "editor",
  owner: "owner",
};
export const SPACE_ROLES = ["owner", "steward", "editor", "commenter", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** Finds the space of resource types access control does not know (comments, todos, ...). */
export type SpaceResolver = (res: ResourceRef) => Promise<string | undefined>;

/** A principal that cannot make requests: a group, or an agent acting for nobody. */
export class PrincipalError extends Error {
  override name = "PrincipalError";
}

// ---------------------------------------------------------------- IDs and tokens

/**
 * SpiceDB object ID of a source document. External IDs outside SpiceDB's ID alphabet are
 * base64url-encoded behind a "=", which a plain ID never starts with.
 */
export function documentObjectId(sourceId: string, externalId: string): string {
  if (SAFE_ID.test(externalId)) return `${sourceId}|${externalId}`;
  return `${sourceId}|=${Buffer.from(externalId, "utf8").toString("base64url")}`;
}

export function documentRef(sourceId: string, externalId: string): ResourceRef {
  return { type: "document", id: `${sourceId}:${externalId}` };
}

/**
 * SpiceDB object ID of a tenant's member, service, group or department. The same principal
 * ID in two tenants is two objects.
 */
export function principalObjectId(tenantId: string, principalId: string): string {
  return `${tenantId}|${principalId}`;
}

/**
 * Graph subject for a canonical principal ID in a tenant: members and services directly,
 * groups and departments as their member sets, the tenant itself as everyone in it.
 */
export function subjectOf(tenantId: string, principalId: string): SubjectRef {
  const kind = kindOf(principalId);
  switch (kind) {
    case "member":
    case "service":
      return subject(kind, principalObjectId(tenantId, principalId));
    case "group":
    case "department":
      return subject(kind, principalObjectId(tenantId, principalId), "member");
    case "tenant":
      if (principalId !== tenantId) throw new PrincipalError(`${principalId} is another tenant`);
      return subject(kind, principalId, "member");
    default:
      throw new PrincipalError(`${principalId} cannot hold a permission directly`);
  }
}

/**
 * Principal tokens for chunk.acl_tokens (written by retrieval), matching scopeFilter's
 * principal_tokens. Every chunk also carries system:<tenant> for service principals.
 */
export function aclTokens(snapshot: AclSnapshot, tenantId: string): string[] {
  const tokens = new Set([`system:${tenantId}`]);
  for (const e of snapshot.entries) {
    switch (e.principal_kind) {
      case "user":
      case "group":
      case "department":
        if (e.principal_id) tokens.add(principalObjectId(tenantId, e.principal_id));
        break;
      case "tenant":
      case "anyone_in_tenant":
        tokens.add(`tenant:${tenantId}`);
        break;
      case "anyone_with_link":
        tokens.add(`link:${tenantId}`);
        break;
      case "public":
        tokens.add("public");
        break;
      case "external":
        break;
    }
  }
  return [...tokens].sort();
}

// ---------------------------------------------------------------- the service

export class AuthzService implements AuthZ, AclMirror {
  readonly graph: Graph;
  readonly store: KnowledgeStore;
  readonly #spaces: SpaceResolver | undefined;

  constructor(graph: Graph, store: KnowledgeStore, options: { spaces?: SpaceResolver } = {}) {
    this.graph = graph;
    this.store = store;
    this.#spaces = options.spaces;
  }

  // ------------------------------------------------------ directory and spaces (admin writes)

  addTenantMember(tenantId: string, principalId: string): Promise<string | undefined> {
    return this.#touch(rel(obj("tenant", tenantId), "member", subjectOf(tenantId, principalId)));
  }

  addTenantAdmin(tenantId: string, memberId: string): Promise<string | undefined> {
    return this.#touch(rel(obj("tenant", tenantId), "admin", subjectOf(tenantId, memberId)));
  }

  addService(tenantId: string, serviceId: string): Promise<string | undefined> {
    return this.#touch(rel(obj("tenant", tenantId), "service", subjectOf(tenantId, serviceId)));
  }

  grantClearance(tenantId: string, principalId: string, label: SensitivityLabel): Promise<string | undefined> {
    const relation = { confidential: "confidential_reader", secret: "secret_reader" }[label as string];
    if (!relation) throw new RangeError("clearance above internal is granted as confidential or secret");
    return this.#touch(rel(obj("tenant", tenantId), relation, subjectOf(tenantId, principalId)));
  }

  /** Add a member or nested group to a group, or a member or sub-department to a department. */
  addMember(tenantId: string, containerId: string, memberId: string): Promise<string | undefined> {
    return this.#touch(rel(this.#container(tenantId, containerId), "member", subjectOf(tenantId, memberId)));
  }

  removeMember(tenantId: string, containerId: string, memberId: string): Promise<string | undefined> {
    return this.graph.write({
      delete: [rel(this.#container(tenantId, containerId), "member", subjectOf(tenantId, memberId))],
    });
  }

  /** Create a space in a tenant; a parent space must be in the same tenant. */
  async createSpace(
    spaceId: string,
    options: { tenantId: string; ownerId: string; parentId?: string },
  ): Promise<string | undefined> {
    const space = obj("space", spaceId);
    const rels = [
      rel(space, "tenant", subject("tenant", options.tenantId)),
      rel(space, "owner", subjectOf(options.tenantId, options.ownerId)),
    ];
    if (options.parentId) {
      if ((await this.#tenantOf(options.parentId)) !== options.tenantId) {
        throw new RangeError(`space ${options.parentId} is in another tenant`);
      }
      rels.push(rel(space, "parent", subject("space", options.parentId)));
    }
    return this.graph.write({ touch: rels });
  }

  /** Grant a role on a space to a principal of the space's own tenant. */
  async grantSpace(spaceId: string, role: SpaceRole, principalId: string): Promise<string | undefined> {
    if (!SPACE_ROLES.includes(role)) throw new RangeError(`unknown space role ${JSON.stringify(role)}`);
    return this.#touch(rel(obj("space", spaceId), role, subjectOf(await this.#tenantOf(spaceId), principalId)));
  }

  async revokeSpace(spaceId: string, role: SpaceRole, principalId: string): Promise<string | undefined> {
    const subj = subjectOf(await this.#tenantOf(spaceId), principalId);
    return this.graph.write({ delete: [rel(obj("space", spaceId), role, subj)] });
  }

  registerSource(sourceId: string, spaceId: string): Promise<string | undefined> {
    return this.#touch(rel(obj("source", sourceId), "space", subject("space", spaceId)));
  }

  #touch(r: Relationship): Promise<string | undefined> {
    return this.graph.write({ touch: [r] });
  }

  #container(tenantId: string, id: string): ObjectRef {
    const kind = kindOf(id);
    if (kind !== "group" && kind !== "department") throw new RangeError(`${id} is not a group or department`);
    return obj(kind, principalObjectId(tenantId, id));
  }

  async #tenantOf(spaceId: string): Promise<string> {
    const [tenant] = await this.graph.read("space", spaceId, "tenant");
    if (!tenant) throw new RangeError(`space ${spaceId} is not registered`);
    return tenant.subject.id;
  }

  // ------------------------------------------------------ AclMirror

  /** Make the document's relationships equal to the snapshot, in one atomic write. */
  async mirror(snapshot: AclSnapshot, { spaceId }: { spaceId: string }): Promise<string | undefined> {
    const tenantId = await this.#tenantOf(spaceId);
    const everyone = subject("tenant", tenantId, "member");
    const source = snapshot.source_id;
    const doc = obj("document", documentObjectId(source, snapshot.external_id));
    const desired = new Map<string, Relationship>();
    const want = (relation: string, s: SubjectRef) => {
      const r = rel(doc, relation, s);
      desired.set(formatRelationship(r), r);
    };
    want("source", subject("source", source));
    if (snapshot.inherits_from_external_id) {
      want("parent", subject("document", documentObjectId(source, snapshot.inherits_from_external_id)));
    }
    const prefixes = { user: "mem_", group: "grp_", department: "dep_" } as const;
    for (const e of snapshot.entries) {
      switch (e.principal_kind) {
        case "user":
        case "group":
        case "department":
          // Unmapped principals, and IDs of the wrong kind, are denied.
          if (e.principal_id?.startsWith(prefixes[e.principal_kind])) {
            want(DOCUMENT_ROLES[e.role], subjectOf(tenantId, e.principal_id));
          }
          break;
        case "tenant":
        case "anyone_in_tenant":
          want("viewer", everyone);
          break;
        case "anyone_with_link":
          want("link_viewer", everyone);
          break;
        case "public":
          want("public_viewer", subject("member", "*"));
          break;
        case "external":
          break;
      }
    }
    const existing = new Map((await this.graph.read("document", doc.id)).map((r) => [formatRelationship(r), r]));
    return this.graph.write({
      touch: [
        ...[...desired].filter(([k]) => !existing.has(k)).map(([, r]) => r),
        rel(obj("source", source), "space", subject("space", spaceId)),
      ],
      delete: [...existing].filter(([k]) => !desired.has(k)).map(([, r]) => r),
    });
  }

  async forget(sourceId: string, externalId: string): Promise<string | undefined> {
    const existing = await this.graph.read("document", documentObjectId(sourceId, externalId));
    return this.graph.write({ delete: existing });
  }

  // ------------------------------------------------------ AuthZ

  #actingSubject(who: Principal): SubjectRef {
    if (who.kind === "agent") {
      if (!who.on_behalf_of) throw new PrincipalError("an agent principal must act on behalf of a member");
      if (kindOf(who.on_behalf_of) !== "member") throw new PrincipalError("an agent acts on behalf of a member");
      return subjectOf(who.tenant_id, who.on_behalf_of);
    }
    if (who.kind === "member" || who.kind === "service") return subjectOf(who.tenant_id, who.id);
    throw new PrincipalError(`a ${who.kind} principal cannot make requests`);
  }

  static #agentLimit(who: Principal, perm: Permission): string | undefined {
    if (who.kind !== "agent") return undefined;
    const scopes = who.agent_scopes ? new Set(who.agent_scopes) : READ_ONLY;
    return scopes.has(perm) ? undefined : `the agent is not granted ${perm}`;
  }

  async spaceOf(res: ResourceRef): Promise<string | undefined> {
    switch (res.type) {
      case "space":
        return res.id;
      case "claim":
        return (await this.store.getClaims([res.id]))[0]?.space_id;
      case "page":
        return (await this.store.getPage(res.id))?.spec.space_id;
      case "source":
      case "document": {
        const sourceId = res.type === "source" ? res.id : (res.id.split(":", 1)[0] as string);
        return (await this.graph.read("source", sourceId, "space"))[0]?.subject.id;
      }
      default:
        return this.#spaces?.(res);
    }
  }

  /** options.memo: per-request cache of document read checks, shared by checkMany. */
  async check(
    who: Principal,
    perm: Permission,
    res: ResourceRef,
    options: { memo?: Map<string, boolean> } = {},
  ): Promise<Decision> {
    const limit = AuthzService.#agentLimit(who, perm);
    if (limit) return { allow: false, reason: limit };
    const s = this.#actingSubject(who);
    if (res.type === "tenant") {
      if (res.id !== who.tenant_id) return { allow: false, reason: "another tenant" };
      return this.#decision(
        await this.graph.check(obj("tenant", res.id), perm === "admin" ? "administer" : "everyone", s),
      );
    }
    const spaceId = await this.spaceOf(res);
    if (who.kind === "agent" && who.space_scope && !(spaceId && who.space_scope.includes(spaceId))) {
      return { allow: false, reason: "outside the agent's space scope" };
    }
    if (res.type === "document") {
      if (!READ_ONLY.has(perm)) return { allow: false, reason: "source documents are read-only in Inspiration" };
      const [sourceId, ...rest] = res.id.split(":");
      const doc = obj("document", documentObjectId(sourceId as string, rest.join(":")));
      return this.#decision(await this.graph.check(doc, "read", s));
    }
    if (res.type === "source") {
      const permission = perm === "admin" ? "admin" : READ_ONLY.has(perm) ? "read" : undefined;
      if (!permission) return { allow: false, reason: `${perm} does not apply to a source` };
      return this.#decision(await this.graph.check(obj("source", res.id), permission, s));
    }
    if (!spaceId) return { allow: false, reason: `unknown ${res.type} ${res.id}` };
    if (!(await this.graph.check(obj("space", spaceId), perm, s))) {
      return { allow: false, reason: `no ${perm} permission on the space` };
    }
    if (res.type === "claim" || res.type === "sop" || res.type === "knowledge_model" || res.type === "entity") {
      const derived = await this.canReadDerived(who, res.id, options);
      if (!derived.allow) return { allow: false, reason: "no readable source supports it" };
    }
    return this.#decision(true);
  }

  #decision(allow: boolean): Decision {
    const token = this.graph.token;
    return {
      allow,
      ...(!allow && { reason: "no permission" }),
      ...(token !== undefined && { consistency_token: token }),
    };
  }

  async checkMany(who: Principal, perm: Permission, resources: readonly ResourceRef[]): Promise<Decision[]> {
    const memo = new Map<string, boolean>();
    return Promise.all(resources.map((r) => this.check(who, perm, r, { memo })));
  }

  async principalTokens(who: Principal): Promise<string[]> {
    const s = this.#actingSubject(who);
    const tenant = obj("tenant", who.tenant_id);
    if (s.type === "service") {
      return (await this.graph.check(tenant, "system", s)) ? [`system:${who.tenant_id}`] : [];
    }
    const [groups, departments, member] = await Promise.all([
      this.graph.lookup("group", "member", s),
      this.graph.lookup("department", "member", s),
      this.graph.check(tenant, "everyone", s),
    ]);
    const tokens = [s.id, ...groups, ...departments, "public"];
    if (member) tokens.push(`tenant:${who.tenant_id}`, `link:${who.tenant_id}`);
    return [...new Set(tokens)].sort();
  }

  async clearance(who: Principal): Promise<SensitivityLabel> {
    const s = this.#actingSubject(who);
    const tenant = obj("tenant", who.tenant_id);
    const [secret, confidential, member] = await this.graph.checkMany(
      [
        [tenant, "clear_secret"],
        [tenant, "clear_confidential"],
        [tenant, "everyone"],
      ],
      s,
    );
    if (secret) return "secret";
    if (confidential) return "confidential";
    return member || s.type === "service" ? "internal" : "public";
  }

  async scopeFilter(who: Principal, perm: Permission): Promise<IndexFilter> {
    if (AuthzService.#agentLimit(who, perm)) return { space_ids: [], principal_tokens: [], max_sensitivity: "public" };
    const s = this.#actingSubject(who);
    const [spaces, tokens, clearance] = await Promise.all([
      this.graph.lookup("space", perm, s),
      this.principalTokens(who),
      this.clearance(who),
    ]);
    const scope = who.kind === "agent" && who.space_scope ? new Set(who.space_scope) : undefined;
    return {
      space_ids: scope ? spaces.filter((id) => scope.has(id)) : spaces,
      principal_tokens: tokens,
      max_sensitivity: clearance,
    };
  }

  /**
   * Readable when at least one source version that supports the unit belongs to a document
   * the viewer can read now. readable_support lists only those source versions.
   *
   * Document checks go to the graph in one bulk call; options.memo carries their results
   * across the units of one request (a search result page, a page's blocks).
   */
  async canReadDerived(
    who: Principal,
    unitId: string,
    options: { memo?: Map<string, boolean> } = {},
  ): Promise<DerivedReadDecision> {
    const s = this.#actingSubject(who);
    const versionIds = supportingVersions(await this.store.lineage(unitId, LINEAGE_DEPTH));
    const versions = (await Promise.all(versionIds.map((id) => this.store.getSourceVersion(id)))).filter(
      (v) => v !== undefined,
    );
    const docOf = new Map(versions.map((v) => [v.id, documentObjectId(v.source_id, v.external_id)]));
    const memo = options.memo ?? new Map<string, boolean>();
    const unknown = [...new Set(docOf.values())].filter((d) => !memo.has(d)).sort();
    if (unknown.length) {
      const results = await this.graph.checkMany(
        unknown.map((d) => [obj("document", d), "read"] as const),
        s,
      );
      for (const [i, d] of unknown.entries()) memo.set(d, results[i] ?? false);
    }
    const readable = versions.filter((v) => memo.get(docOf.get(v.id) ?? "")).map((v) => v.id);
    return { allow: readable.length > 0, readable_support: readable };
  }
}

/**
 * The source versions reachable from the graph's root along support paths: supporting
 * evidence, a span's version, derivations and dependencies. Contradicting and qualifying
 * evidence, supersession and mentions lead nowhere.
 */
export function supportingVersions(graph: LineageGraph): string[] {
  const next = new Map<string, string[]>();
  const link = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to]);
  for (const e of graph.edges) {
    if (e.relation === "cites" && e.role === "supports") link(e.from_id, e.to_id);
    else if (e.relation === "contains") link(e.to_id, e.from_id);
    else if (e.relation === "derived_from" || e.relation === "depends_on") link(e.from_id, e.to_id);
  }
  const seen = new Set([graph.root_id]);
  const queue = [graph.root_id];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const to of next.get(id) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return [...seen].filter((id) => kindOf(id) === "source_version").sort();
}
