/**
 * The permission service: AuthZ over a relationship graph.
 *
 * Rules, in one place:
 *
 * - Visibility comes from spaces. A source belongs to one space, and its documents are
 *   readable by whoever may read that space. Source ACLs decide nothing: source-sync keeps
 *   them as advisory snapshots.
 * - Spaces hold Inspiration roles: viewer < commenter < editor < steward < owner, each
 *   holding in every space below. A tenant admin administers every space of the tenant (its
 *   name, owners and audience) but reads only the spaces whose audience includes them.
 * - Derived knowledge (claims, pages, SOPs) is readable only through source documents the
 *   viewer can read now, found by walking lineage along support paths: supporting evidence,
 *   derivations and dependencies. Contradicting or qualifying evidence never makes a claim
 *   readable. Hidden support is never counted or named.
 * - An agent acts on behalf of a member: its rights are the member's, cut down to its
 *   agent_scopes (read and discover when absent) and its space_scope.
 * - Principal IDs are unique only within their tenant (a person may have the same member ID
 *   in every tenant they join). Members, services, groups and departments are therefore
 *   keyed by tenant in the graph, and a principal only ever gets rights in its own tenant.
 * - Clearance comes from the graph (internal for every member, confidential or secret where
 *   granted) and bounds search. A token may lower it (the principal's max_sensitivity); then
 *   a document (by its latest version), a claim or a page labelled above that ceiling is
 *   hidden from direct reads too.
 * - Search indexes get an IndexFilter (spaces, the tenant's token, clearance) so ranking only
 *   ever sees rows the viewer may read; results are still re-checked before they leave.
 *
 * Every write returns the graph's consistency token (a SpiceDB ZedToken), which callers pass
 * on as consistency_token so a later read can ask for results at least that fresh.
 */

import type {
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
  SpaceRole,
} from "@inspiration/contracts";
import { allows, kindOf } from "@inspiration/contracts";
import { type Graph, type ObjectRef, obj, type Relationship, rel, type SubjectRef, subject } from "./graph.ts";

const READ_ONLY: ReadonlySet<Permission> = new Set(["discover", "read"]);
/** How far canReadDerived walks lineage from a unit towards its source versions. */
export const LINEAGE_DEPTH = 6;
/** Space roles from the highest, with the permission that holding one (or a higher) grants. */
const ROLE_PERMISSIONS = [
  ["owner", "own"],
  ["steward", "verify"],
  ["editor", "edit"],
  ["commenter", "comment"],
  ["viewer", "read"],
] as const satisfies readonly (readonly [SpaceRole, string])[];
export const SPACE_ROLES = ROLE_PERMISSIONS.map(([role]) => role);

/** Finds the space of resource types access control does not know (comments, todos, ...). */
export type SpaceResolver = (res: ResourceRef) => Promise<string | undefined>;

/** A principal that cannot make requests: a group, or an agent acting for nobody. */
export class PrincipalError extends Error {
  override name = "PrincipalError";
}

// ---------------------------------------------------------------- IDs and tokens

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
 * The tokens retrieval writes into chunk.acl_tokens, matching scopeFilter's principal_tokens:
 * tenant:<tenant> for its members and system:<tenant> for its services. Spaces decide who
 * reads a chunk; the tokens keep tenants apart inside the index.
 */
export function chunkTokens(tenantId: string): string[] {
  return [`system:${tenantId}`, `tenant:${tenantId}`];
}

// ---------------------------------------------------------------- the service

export class AuthzService implements AuthZ {
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

  /** options.memo: per-request cache of source read checks, shared by checkMany. */
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
      const [sourceId = "", ...rest] = res.id.split(":");
      if (!(await this.graph.check(obj("source", sourceId), "read", s))) return this.#decision(false);
      if (!who.max_sensitivity) return this.#decision(true);
      const latest = await this.store.latestSourceVersion(sourceId, rest.join(":"));
      return this.#withinCeiling(who, latest?.sensitivity);
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
    if (who.max_sensitivity && res.type === "claim") {
      return this.#withinCeiling(who, (await this.store.getClaims([res.id]))[0]?.sensitivity);
    }
    if (who.max_sensitivity && res.type === "page") {
      return this.#withinCeiling(who, (await this.store.getPage(res.id))?.spec.sensitivity);
    }
    return this.#decision(true);
  }

  /** Whether a label is within the ceiling the principal's token sets. */
  #withinCeiling(who: Principal, label: SensitivityLabel | undefined): Decision {
    if (!who.max_sensitivity || label === undefined || allows(who.max_sensitivity, label)) return this.#decision(true);
    return { ...this.#decision(false), reason: `labelled ${label}, above the token's max_sensitivity` };
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

  /** The chunk tokens (chunkTokens) the principal matches: its tenant's, if it belongs to the tenant. */
  async principalTokens(who: Principal): Promise<string[]> {
    const s = this.#actingSubject(who);
    const tenant = obj("tenant", who.tenant_id);
    if (s.type === "service") {
      return (await this.graph.check(tenant, "system", s)) ? [`system:${who.tenant_id}`] : [];
    }
    return (await this.graph.check(tenant, "everyone", s)) ? [`tenant:${who.tenant_id}`] : [];
  }

  /**
   * The highest role the principal holds on each space, directly, through a group or the
   * whole tenant, or from a space above; undefined where it holds none. A tenant admin
   * manages every space without holding a role on it.
   */
  async spaceRoles(who: Principal, spaceIds: readonly string[]): Promise<(SpaceRole | undefined)[]> {
    const s = this.#actingSubject(who);
    const held = await this.graph.checkMany(
      spaceIds.flatMap((id) => ROLE_PERMISSIONS.map(([, perm]) => [obj("space", id), perm] as const)),
      s,
    );
    return spaceIds.map((_, i) => {
      const at = ROLE_PERMISSIONS.findIndex((_, r) => held[i * ROLE_PERMISSIONS.length + r]);
      return at < 0 ? undefined : ROLE_PERMISSIONS[at]?.[0];
    });
  }

  /** The members who own a space, by member ID. */
  async spaceOwners(spaceId: string): Promise<string[]> {
    const owners = await this.graph.read("space", spaceId, "owner");
    return owners.map((r) => r.subject.id.slice(r.subject.id.indexOf("|") + 1)).sort();
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
    const granted: SensitivityLabel = secret
      ? "secret"
      : confidential
        ? "confidential"
        : member || s.type === "service"
          ? "internal"
          : "public";
    // A token may narrow the clearance, never widen it.
    return who.max_sensitivity && !allows(who.max_sensitivity, granted) ? who.max_sensitivity : granted;
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
   * the viewer can read now, that is a source in a space they may read. readable_support
   * lists only those source versions.
   *
   * Source checks go to the graph in one bulk call; options.memo carries their results
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
    const memo = options.memo ?? new Map<string, boolean>();
    const unknown = [...new Set(versions.map((v) => v.source_id))].filter((id) => !memo.has(id)).sort();
    if (unknown.length) {
      const results = await this.graph.checkMany(
        unknown.map((id) => [obj("source", id), "read"] as const),
        s,
      );
      for (const [i, id] of unknown.entries()) memo.set(id, results[i] ?? false);
    }
    const readable = versions.filter((v) => memo.get(v.source_id)).map((v) => v.id);
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
