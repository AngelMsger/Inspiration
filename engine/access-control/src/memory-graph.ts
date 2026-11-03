/** An in-memory evaluator of schema.zed, for component tests. */

import {
  formatRelationship,
  type Graph,
  GraphError,
  type ObjectRef,
  type Relationship,
  type SubjectRef,
  schemaText,
  sortRelationships,
} from "./graph.ts";

interface AllowedSubject {
  type: string;
  /** "*" for a wildcard; usersets carry a relation. */
  wildcard: boolean;
  relation?: string;
}

interface Definition {
  relations: Map<string, AllowedSubject[]>;
  /** A union of terms: a relation or permission of the same object, or an arrow (left->right). */
  permissions: Map<string, { left: string; arrow?: string }[]>;
}

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const DEFINITION = /definition\s+(\w+)\s*\{([\s\S]*?)\}/g;
const RELATION = /relation\s+(\w+)\s*:\s*([^\n]+)/g;
const PERMISSION = /permission\s+(\w+)\s*=\s*([^\n]+)/g;

/**
 * Parse the subset of the SpiceDB schema language schema.zed uses: relations with subject
 * types, usersets and wildcards; permissions that are unions of relations, permissions and
 * arrows. Intersections, exclusions and caveats are rejected.
 */
export function parseSchema(text: string): Map<string, Definition> {
  const out = new Map<string, Definition>();
  for (const [, name, body] of text.replace(COMMENTS, "").matchAll(DEFINITION)) {
    if (!name || body === undefined) continue;
    const relations = new Map<string, AllowedSubject[]>();
    for (const [, relation, types] of body.matchAll(RELATION)) {
      if (!relation || !types) continue;
      relations.set(
        relation,
        types.split("|").map((t) => {
          const term = t.trim();
          if (term.endsWith(":*")) return { type: term.slice(0, -2), wildcard: true };
          const [type, sub] = term.split("#") as [string, string | undefined];
          return sub ? { type, wildcard: false, relation: sub } : { type, wildcard: false };
        }),
      );
    }
    const permissions = new Map<string, { left: string; arrow?: string }[]>();
    for (const [, permission, expr] of body.matchAll(PERMISSION)) {
      if (!permission || !expr) continue;
      if (/[&()]| - |with /.test(expr)) {
        throw new GraphError(`${name}.${permission}: the in-memory evaluator supports only unions`);
      }
      permissions.set(
        permission,
        expr.split("+").map((term) => {
          const [left, arrow] = term.split("->").map((s) => s.trim()) as [string, string | undefined];
          return arrow ? { left, arrow } : { left };
        }),
      );
    }
    out.set(name, { relations, permissions });
  }
  return out;
}

const objectKey = (o: ObjectRef, relation: string) => `${o.type}:${o.id}#${relation}`;
const sameSubject = (a: SubjectRef, b: SubjectRef) =>
  a.type === b.type && a.id === b.id && (a.relation ?? "") === (b.relation ?? "");

/**
 * Evaluates schema.zed with SpiceDB's semantics for unions, arrows, usersets and wildcards.
 * Relationships are validated against the schema as SpiceDB does. The consistency token is
 * a write counter.
 */
export class MemoryGraph implements Graph {
  readonly schema: Map<string, Definition>;
  token: string | undefined;
  /** By resource and relation, then by the relationship's text form. */
  readonly #rels = new Map<string, Map<string, Relationship>>();
  #revision = 0;

  constructor(schema: string = schemaText()) {
    this.schema = parseSchema(schema);
  }

  #validate(r: Relationship): void {
    const allowed = this.schema.get(r.resource.type)?.relations.get(r.relation);
    if (!allowed) throw new GraphError(`${formatRelationship(r)}: ${r.resource.type} has no relation ${r.relation}`);
    const s = r.subject;
    const ok = allowed.some(
      (a) =>
        a.type === s.type &&
        (a.wildcard ? s.id === "*" && !s.relation : s.id !== "*" && (a.relation ?? "") === (s.relation ?? "")),
    );
    if (!ok) {
      throw new GraphError(`${formatRelationship(r)}: subject type not allowed on ${r.resource.type}#${r.relation}`);
    }
  }

  async write(updates: {
    touch?: readonly Relationship[];
    delete?: readonly Relationship[];
  }): Promise<string | undefined> {
    const touch = updates.touch ?? [];
    const remove = updates.delete ?? [];
    for (const r of touch) this.#validate(r);
    if (!touch.length && !remove.length) return this.token;
    for (const r of remove) this.#rels.get(objectKey(r.resource, r.relation))?.delete(formatRelationship(r));
    for (const r of touch) {
      const k = objectKey(r.resource, r.relation);
      const bucket = this.#rels.get(k) ?? new Map<string, Relationship>();
      bucket.set(formatRelationship(r), structuredClone(r));
      this.#rels.set(k, bucket);
    }
    this.#revision += 1;
    this.token = String(this.#revision);
    return this.token;
  }

  async read(resourceType: string, resourceId?: string, relation?: string): Promise<Relationship[]> {
    // One object's relation is one bucket: scanning them all made every document check cost the
    // size of the whole graph.
    const buckets =
      resourceId !== undefined && relation !== undefined
        ? [this.#rels.get(objectKey({ type: resourceType, id: resourceId }, relation)) ?? new Map()]
        : [...this.#rels.values()];
    const found = buckets.flatMap((bucket) =>
      [...bucket.values()].filter(
        (r) =>
          r.resource.type === resourceType &&
          (resourceId === undefined || r.resource.id === resourceId) &&
          (relation === undefined || r.relation === relation),
      ),
    );
    return structuredClone(sortRelationships(found));
  }

  #related(o: ObjectRef, relation: string): Iterable<Relationship> {
    return this.#rels.get(objectKey(o, relation))?.values() ?? [];
  }

  #has(o: ObjectRef, name: string, s: SubjectRef, seen: ReadonlySet<string>): boolean {
    const key = objectKey(o, name);
    if (seen.has(key)) return false;
    const next = new Set(seen).add(key);
    const d = this.schema.get(o.type);
    if (!d) return false;
    if (d.relations.has(name)) {
      for (const r of this.#related(o, name)) {
        const t = r.subject;
        if (sameSubject(t, s) || (t.id === "*" && t.type === s.type && !s.relation)) return true;
        if (t.relation && this.#has({ type: t.type, id: t.id }, t.relation, s, next)) return true;
      }
      return false;
    }
    for (const { left, arrow } of d.permissions.get(name) ?? []) {
      if (arrow === undefined) {
        if (this.#has(o, left, s, next)) return true;
        continue;
      }
      for (const r of this.#related(o, left)) {
        if (this.#has({ type: r.subject.type, id: r.subject.id }, arrow, s, next)) return true;
      }
    }
    return false;
  }

  async check(resource: ObjectRef, permission: string, s: SubjectRef): Promise<boolean> {
    return this.#has(resource, permission, s, new Set());
  }

  async checkMany(items: readonly (readonly [ObjectRef, string])[], s: SubjectRef): Promise<boolean[]> {
    return items.map(([o, p]) => this.#has(o, p, s, new Set()));
  }

  async lookup(resourceType: string, permission: string, s: SubjectRef): Promise<string[]> {
    const ids = new Set(
      [...this.#rels.values()].flatMap((bucket) =>
        [...bucket.values()].filter((r) => r.resource.type === resourceType).map((r) => r.resource.id),
      ),
    );
    return [...ids].filter((id) => this.#has({ type: resourceType, id }, permission, s, new Set())).sort();
  }
}
